/**
 * SkateApp — the application layer, extracted from index.html.
 *
 * Architecture (state-driven):
 *   SkateConfig (data)  →  Render.* (pure-ish DOM generation)  →  Actions.*
 *   (named intents)  →  module APIs (SkateChat / SkateGuides / SkateAPI)
 *
 * - `S` is the single app-state object (filters, paging, UI flags, pending
 *   deep-links, composer reply state). Module state lives in the modules.
 * - Every repeated structure (tabs, chips, options, rooms, categories,
 *   menu labels, routes) renders by iterating SkateConfig — replace that
 *   object with an API payload and the UI follows.
 * - All user content renders via SkateUI.el()/escapeHtml; interactions go
 *   through delegation tables — no user string ever sits in a handler.
 * - Markup contract (classes / ids / data-attributes) is byte-identical
 *   to the previous inline version, so style.css keeps targeting cleanly.
 */
window.SkateApp = (() => {
    'use strict';

    const { $, $$, escapeHtml, parseLocalDate, mapsUrl, hueOf, hueDot, shortPk,
            el, copyText, flash, chips, fillSelect, Popover, Modal, delegate } = SkateUI;
    const CFG = window.SkateConfig;

    /** Persisted type selection → sane shape ({cat: 'all' | [sub…]}). */
    function sanitizeTypes(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        const cats = new Set(CFG.programTypes.map(t => t.id)), subs = new Set(CFG.subTypes.map(t => t.id));
        Object.entries(raw).forEach(([cat, sel]) => {
            if (!cats.has(cat)) return;
            if (sel === 'all') out[cat] = 'all';
            else if (Array.isArray(sel)) { const v = sel.filter(x => subs.has(x)); if (v.length) out[cat] = v; }
        });
        return out;
    }
    /** Persisted hockey kind → null (any kind) or [one kind] (v3.12.3: one at a time; "other" is never a choice). */
    function sanitizeKinds(raw) {
        if (!Array.isArray(raw)) return null;
        const v = [...new Set(raw.filter(x => x !== 'other' && CFG.hockeyKinds.some(k => k.id === x)))];
        return v.length === 1 ? v : null;
    }

    const S = {
        programs: [], filtered: [], limit: 30, paidMatching: 0,
        facts: null,   // v3.7 venue-facts.json (rentals / admission / helmets per rink key)
        lending: null, // v3.11 lending.json (free skates: the City's lending van + other confirmed options)
        search: '', showPast: false, age: null, savedOnly: false,
        // v3.2 filters. Persisted: types {cat: 'all' | [subtype…]} ({} = every
        // type), cities ([] = everywhere), paidVisible, rinkScope, sort.
        // Session-only: day, age, savedOnly, showPast, nearRink.
        types: sanitizeTypes(SkateSettings.get('typeSel')),
        kinds: sanitizeKinds(SkateSettings.get('hockeyKinds')),   // v3.12.2: null = every kind of hockey
        cities: Array.isArray(SkateSettings.get('cities')) ? SkateSettings.get('cities').filter(c => typeof c === 'string') : [],
        day: '',                       // '' | 'today' | 'tomorrow' | 'weekend' | weekday name
        dateFrom: null, dateTo: null,  // v3.16: one day or a range from the date picker (YYYY-MM-DD; not kept between visits)
        barDay: null,                  // v3.16: the day the bar names (the one at the top of the list)
        calRenderedWeek: null,         // to keep the grid's scroll position across the minute re-render
        heartHint: false,              // first card carries the one-time "tap ♡ to save" nudge (Render.programs decides)
        cal2Day: null,                 // Calendar 2.0's selected day (today until tapped)
        cal2By: ['time', 'rink', 'distance'].includes(SkateSettings.get('cal2By')) ? SkateSettings.get('cal2By') : 'time',   // the day planner's grouping: time of day | rink | distance (v3.12)
        radius: CFG.radiusOptions.includes(SkateSettings.get('radius')) ? SkateSettings.get('radius') : null,   // v3.12: only sessions within N km of the reader's spot (null = any distance)
        radiusWanted: null,            // a radius picked before any spot was set: applied once one is
        statusAll: false,              // Data status sheet: every city for one look, whatever the filter says
        cal2ShowEnded: false,          // Calendar 2.0: today's ended sessions unfolded
        paidVisible: !SkateSettings.get('freeOnly'),   // everything shows with its price unless Free only is on
        rinkScope: SkateSettings.get('rinkScope') || 'all',
        sort: SkateSettings.get('sort') || 'time',
        calMode: !!SkateSettings.get('calMode'),
        calWeekOffset: 0,
        showDropped: false,            // include City sessions toronto.ca no longer lists (hidden by default: toronto.ca is the ground truth)
        moreFilters: false,            // Filters sheet: the collapsed "More options" section
        rinksAllCities: false,         // Rinks view: ignore the Where cities for one look
        rinksCity: null,               // Rinks view: a city picked in the sheet ('all' = every city, null = follow the filters)
        nearRink: null,                // {key, name} — "Sessions" from the Rinks view
        expandedCats: {},              // Filters sheet: which categories show their age groups
        activeGuideId: null, guideCat: '',
        chatOpen: false, chatFilter: 'all',
        replyTo: null,                 // chat reply {id, from, text}
        guideReply: null,              // guide comment reply {id, name}
        shareCtx: null,                // {type:'program'|'guide', payload}
        pendingInvite: null,
        pendingGuideOpen: null,
        pendingProgramFocus: null,
        lastRenderedConv: null,        // autofocus + jump-pill reset key
        jumpBase: 0, lastVisibleCount: 0
    };

    const identity = () => SkateChat.getIdentity();
    const baseUrl = () => `${window.location.origin}${window.location.pathname}`;
    const fmtClock = t => SkateSettings.formatClock(t);

    /* ================= Program field helpers ================= */
    const P = {
        activity: p => p.Activity || p['Activity Title'] || '',
        location: p => p.LocationName || p['Location Name'] || '',
        dateStr:  p => p['Start Date Time'] || p['Start Date'] || '',
        time:     p => p['Start Time'] || '',
        endTime:  p => p['End Time'] || '',
        id:       p => SkateFavorites.getId(p),

        /**
         * Stable location key shared with rinks.json:
         * city → String(Location ID); external without a city id →
         * 'ext-<source>' (matches the synthetic rinks.json entries);
         * last resort → normalized name.
         */
        locKey(p) {
            if (p.ExtLocationKey) return p.ExtLocationKey;   // multi-venue sources (per-venue key)
            if (p['Location ID'] != null) return String(p['Location ID']);
            if (p.Source && p.Source !== 'city') return 'ext-' + p.Source;
            return 'name:' + P.location(p).toLowerCase();
        },

        /** Category id from the keyword table ('hockey', 'leisure', …) or 'other'. */
        category(p) {
            const a = P.activity(p).toLowerCase();
            const hit = CFG.activityTags.find(t => t.keywords.some(k => a.includes(k)));
            return hit ? hit.cls : 'other';
        },

        /**
         * Audience sub-type from the title words + age bounds:
         * 'women' | 'older' | 'child' | 'youth' | 'adult' | 'all'. Drives the
         * age-group checkboxes under each category in Filters.
         */
        subType(p) {
            const a = ' ' + P.activity(p).toLowerCase() + ' ';
            const min = P.age(p['Age Min']), max = P.age(p['Age Max']);
            if (/women|girls|ladies|female/.test(a)) return 'women';
            if (/older adult|senior|\b5[05]\+|\b6[05]\+/.test(a) || (min != null && min >= 50)) return 'older';
            if (/child|\btot\b|parent|family|\bkids?\b|preschool|under 4/.test(a) || (max != null && max <= 12)) return 'child';
            if (/youth|teen|junior/.test(a) || (min != null && min >= 13 && max != null && max <= 19)) return 'youth';
            if (/adult|\b1[689]\+/.test(a) || (min != null && min >= 16)) return 'adult';
            return 'all';
        },

        /** Municipality label for the Where filter (source-level, else District). */
        city(p) { return CFG.sourceInfo[p.Source || 'city']?.city || p.District || 'Toronto'; },

        /** Type filter: {} = everything; per category 'all' or a list of sub-types. */
        matchesTypes(p, types = S.types, kinds = S.kinds) {
            if (!Object.keys(types).length) return true;
            const cat = P.category(p), sel = types[cat];
            if (!sel) return false;
            if (sel !== 'all' && !sel.includes(P.subType(p))) return false;
            // v3.12.2: hockey can also be narrowed by kind, together with the ages
            return !(cat === 'hockey' && Array.isArray(kinds) && kinds.length && !kinds.includes(P.hockeyKind(p)));
        },

        /** v3.12.2: hockey by kind, from the title: 'stickpuck' | 'pickup' | 'other'. */
        hockeyKind(p) {
            const a = P.activity(p).toLowerCase();
            if (/stick\W*(?:and|n)?\W*puck/.test(a)) return 'stickpuck';      // "Stick & Puck", "stick and puck", "stick 'n' puck"
            if (/shinny|pick\W?up|drop\W?in hockey/.test(a)) return 'pickup';
            return 'other';
        },

        /** Config-driven activity badge (first keyword table hit wins). */
        tagFor(p) {
            const a = P.activity(p).toLowerCase();
            const hit = CFG.activityTags.find(t => t.keywords.some(k => a.includes(k)));
            return hit ? `<span class="tag ${hit.cls}">${hit.emoji ? hit.emoji + ' ' : ''}${hit.label}</span>` : '';
        },

        /** Same keyword table → css class for the calendar's color coding. */
        typeCls(p) {
            const a = P.activity(p).toLowerCase();
            const hit = CFG.activityTags.find(t => t.keywords.some(k => a.includes(k)));
            return hit ? hit.cls : null;
        },

        /** "13" → 13, null/"None"/undefined → null. Data is normalized at
         *  fetch time; stay defensive for older cached datasets. */
        age(v) {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? n : null;
        },

        ageBadge(p) {
            let min = P.age(p['Age Min']), max = P.age(p['Age Max']);
            if (min === 0) min = null;   // "0+" is just everyone
            if (min != null && max != null) return `<span class="age-badge">Ages ${min}–${max}</span>`;
            if (min != null) return `<span class="age-badge">${min >= 18 ? 'Adults' : 'Ages'} ${min}+</span>`;
            if (max != null) return `<span class="age-badge">Up to ${max}</span>`;
            return '<span class="age-badge all-ages">All Ages</span>';
        }
    };

    /* ---------- Official pages ("verify before you go") ----------
       City rows link to the toronto.ca location page — the same live
       schedule the rink staff go by (the Open Data export lags it);
       external venues link to their own site. */
    const TORONTO_LOC_URL = 'https://www.toronto.ca/explore-enjoy/parks-recreation/places-spaces/parks-and-recreation-facilities/location/?id=';
    const httpOnly = u => (/^https?:\/\//i.test(u || '') ? u : null);
    function officialUrl(p) {
        if (!p) return null;
        if (!p.Source || p.Source === 'city') return p['Location ID'] != null ? TORONTO_LOC_URL + encodeURIComponent(p['Location ID']) : null;
        return httpOnly(p.InfoUrl);
    }
    function officialSite(p) { return CFG.sourceInfo[p?.Source || 'city']?.site || 'venue site'; }

    /* ---------- Venue facts (v3.7) ----------
     * What a rink's own website says about skate rentals, admission and
     * helmets, read and verified by the pipeline (every fact carries the
     * sentence it came from). Keyed like rinks.json. Unknown = shown as nothing. */
    function factsFor(key) { return (S.facts && S.facts.venues && S.facts.venues[key]) || null; }
    function factsBits(f) {
        const bits = [];
        const unit = (u) => (u && u !== 'unknown') ? ` ${u}` : '';
        if (f.rentals) {
            // a "price" of 0 is a free day or a condition, never the price of a rental: say rentals exist, not "$0"
            if (f.rentals.available === 'yes') bits.push(`Skate rentals${f.rentals.price > 0 ? ` $${fmtPrice(f.rentals.price)}${unit(f.rentals.unit)}` : ''}`);
            else if (f.rentals.available === 'no') bits.push('No skate rentals');
        }
        if (f.admission) bits.push(f.admission.unit === 'free' ? 'Free skating' : `Skating $${fmtPrice(f.admission.price)}${unit(f.admission.unit)}`);
        if (f.helmets) {
            if (f.helmets.rule === 'required') bits.push('Helmets required');
            else if (f.helmets.rule === 'required under age') bits.push(f.helmets.maxAge != null ? `Helmets required for ages ${f.helmets.maxAge} and under` : 'Helmets required for children');
            else if (f.helmets.rule === 'recommended') bits.push('Helmets recommended');
        }
        return bits;
    }
    /* ---------- Free skates (v3.11) ----------
     * lending.json from the pipeline: the City's Skate Lending Library van
     * (one rink a day, free skates, helmets and skating aids) plus a few other
     * free options read on their own pages. Indexed once per load, so a card,
     * a day heading and a rink row each cost one Map lookup. */
    let lendIx = null;
    function setLending(data) {
        S.lending = data || null;
        lendIx = null;
        if (!data || !data.van) return;
        // only well-formed entries get in: this file is read from the network
        const byDay = new Map(), byRink = new Map();
        const YMD = /^\d{4}-\d{2}-\d{2}$/, HM = /^\d{2}:\d{2}$/;
        const ok = (s) => s && typeof s === 'object' && YMD.test(s.date || '') && HM.test(s.from || '') && HM.test(s.to || '') && typeof s.place === 'string';
        const stops = (Array.isArray(data.van.stops) ? data.van.stops : []).filter(ok).sort((a, b) => (a.date + a.from < b.date + b.from ? -1 : 1));
        for (const s of stops) {
            if (!byDay.has(s.date)) byDay.set(s.date, []);
            byDay.get(s.date).push(s);
            if (s.rink) { if (!byRink.has(s.rink)) byRink.set(s.rink, []); byRink.get(s.rink).push(s); }
        }
        const okAlso = (a) => a && typeof a === 'object' && typeof a.place === 'string' && typeof a.what === 'string' && YMD.test(a.start || '') && YMD.test(a.end || '') &&
            (a.date === undefined || YMD.test(a.date)) && (a.days === undefined || (Array.isArray(a.days) && a.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6))) &&
            (a.from === undefined || (HM.test(a.from) && HM.test(a.to || '')));
        lendIx = { stops, byDay, byRink, also: (Array.isArray(data.also) ? data.also : []).filter(okAlso) };
    }
    /** "4–8 PM", "10 AM–4 PM", or "16:00–20:00" on a 24-hour clock. */
    function lendHours(from, to) {
        if (SkateSettings.get('timeFormat') === '24h') return `${from}–${to}`;
        const part = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return { n: `${h % 12 === 0 ? 12 : h % 12}${m ? ':' + String(m).padStart(2, '0') : ''}`, half: h >= 12 ? 'PM' : 'AM' }; };
        const a = part(from), b = part(to);
        return a.half === b.half ? `${a.n}–${b.n} ${b.half}` : `${a.n} ${a.half}–${b.n} ${b.half}`;
    }
    const lendWeekday = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
    const lendDate = (day) => parseLocalDate(day).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
    const lendShort = (day) => parseLocalDate(day).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
    /** Is one of the "also free" entries on, that day? */
    function lendAlsoOn(a, day) {
        if (day < a.start || day > a.end) return false;
        if (a.rink && rinkShut(a.rink)) return false;   // v3.12: Harbourfront's free Saturdays wait for Harbourfront to open
        if (a.date) return a.date === day;
        return !a.days || a.days.includes(lendWeekday(day));
    }
    /** Free skates during THIS session at ITS rink, or null. */
    function lendFor(p) {
        if (!lendIx) return null;
        const key = P.locKey(p), day = P.dateStr(p).slice(0, 10), st = p['Start Time'] || '', en = p['End Time'] || '';
        const during = (from, to) => !st || !en || !from || !to || (from < en && st < to);
        const stop = (lendIx.byDay.get(day) || []).find(s => s.rink === key && during(s.from, s.to));
        if (stop) return { text: `Free skates ${lendHours(stop.from, stop.to)}`, title: `The City's Skate Lending Library van is at this rink ${lendHours(stop.from, stop.to)}: free skates, helmets and skating aids. No reservation.` };
        const also = lendIx.also.find(a => a.rink === key && lendAlsoOn(a, day) && during(a.from, a.to));
        return also ? { text: 'Free skates', title: `${also.what}.` } : null;
    }
    /** Everything free on a given day, van first: [{ place, hours }]. */
    function lendOn(day) {
        if (!lendIx) return [];
        const out = (lendIx.byDay.get(day) || []).map(s => ({ place: s.place, hours: lendHours(s.from, s.to) }));
        for (const a of lendIx.also) if (a.days && lendAlsoOn(a, day)) out.push({ place: a.place, hours: a.from && a.to ? lendHours(a.from, a.to) : '' });
        for (const a of lendIx.also) if (a.date && lendAlsoOn(a, day)) out.push({ place: a.place, hours: a.from && a.to ? lendHours(a.from, a.to) : '' });
        return out;
    }
    /** For a rink's row: its next lending visit, as words. */
    function lendNextAt(key, today = SkateTime.todayKey()) {
        if (!lendIx) return null;
        const next = (lendIx.byRink.get(key) || []).find(s => s.date >= today);
        if (next) return `Free skates ${next.date === today ? 'today' : lendDate(next.date)}, ${lendHours(next.from, next.to)}`;
        const also = lendIx.also.find(a => a.rink === key && a.end >= today && !a.date);
        return also && !rinkShut(key) ? 'Free skates to borrow' : null;   // v3.12: not while the rink itself is shut
    }

    function factsTitle(f, field) {
        let host = ''; try { host = new URL(f.url).hostname.replace(/^www\./, ''); } catch { /* no url */ }
        const when = f.checkedAt ? new Date(f.checkedAt).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
        const q = f[field] && f[field].quote ? `\n“${f[field].quote}”` : '';
        return `${factsBits(f).join(' · ')}\nFrom ${host || 'the venue site'}${when ? `, checked ${when}` : ''}.${q}`;
    }
    /** Same, for a rinks.json entry (map popups / locator). */
    function officialUrlForRink(r) {
        if (!r) return null;
        if (r.source === 'city' && /^\d+$/.test(String(r.locationid))) return TORONTO_LOC_URL + r.locationid;
        return httpOnly(r.website);
    }

    /** 7.5 → "7.50", 5 → "5", null → "?" — prices read like a price tag. */
    function fmtPrice(n) { return n == null ? '?' : Number(n).toFixed(2).replace(/\.00$/, ''); }
    /** v3.15.3: a paid session's price as people read it: "$5.90", "$0–22.73" when it depends on who you are
     *  (U of T: free for members, a day pass for anyone else), or "Paid" when the venue does not publish one. */
    function priceLabel(p) {
        if (p.Price == null || !Number.isFinite(Number(p.Price))) return 'Paid';
        const min = p.PriceMin != null && Number.isFinite(Number(p.PriceMin)) && Number(p.PriceMin) < Number(p.Price) ? `${fmtPrice(p.PriceMin)}–` : '';
        return `$${min}${fmtPrice(p.Price)}`;
    }

    /** "Ages 13–18" / "Adults 19+" / "Up to 12" / "All ages" as plain text. */
    function ageText(p) {
        let min = P.age(p['Age Min']), max = P.age(p['Age Max']);
        if (min === 0) min = null;
        if (min != null && max != null) return `Ages ${min}–${max}`;
        if (min != null) return `${min >= 18 ? 'Adults' : 'Ages'} ${min}+`;
        if (max != null) return `Up to ${max}`;
        return 'All ages';
    }

    function programText(p) {
        const date = P.dateStr(p) ? parseLocalDate(P.dateStr(p)).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }) : '';
        const off = officialUrl(p);
        const city = P.city(p);
        return `${P.activity(p)}\n${P.location(p)}${city !== 'Toronto' ? ', ' + city : ''}\n${date}${P.time(p) ? ' at ' + fmtClock(P.time(p)) : ''}` +
            (p.Paid ? `\nPaid${p.Price != null ? ', ' + priceLabel(p) : ''}` : (p.PriceNote ? `\n${p.PriceNote}` : '')) +
            (off ? `\nVerify: ${off}` : '') +
            `\n\n${baseUrl()}#p=${P.id(p)}`;
    }

    /* ---------- Add to calendar (opens the calendar app) ----------
       One event description shared by every target: Google / Outlook get
       a deep link that opens their app or site with the fields filled;
       Apple and everything else take an .ics. Times are converted from
       Toronto wall-clock to UTC so any device lands on the right hour. */
    function calEvent(p) {
        const st = SkateTime.status(p);
        if (!st.startEpoch) return null;
        const addr = [p.Address, p.PostalCode].filter(Boolean).join(', ');
        const town = p.Source && p.Source !== 'city' && p.District ? p.District : 'Toronto';
        const off = officialUrl(p);
        const details = [
            `${P.activity(p)} · ${ageText(p)}`,
            addr ? `${P.location(p)}, ${addr}` : P.location(p),
            p.Paid ? `Paid session${p.Price != null ? ` · ${priceLabel(p)}` : ''}${p.RegistrationUrl ? ` · ${p.RegistrationUrl === p.InfoUrl ? 'Details' : 'Register'}: ${p.RegistrationUrl}` : ''}` : (p.PriceNote || 'Free drop-in'),
            p.Unverified ? 'Unverified schedule (read from the venue site). Confirm with the venue.' : '',
            off ? `Verify on ${officialSite(p)}: ${off}` : '',
            `Toronto Skating: ${baseUrl()}#p=${P.id(p)}`
        ].filter(Boolean).join('\n');
        return {
            title: `${P.activity(p)} at ${P.location(p)}`,
            start: st.startEpoch, end: st.endEpoch,
            date: P.dateStr(p).slice(0, 10), startTime: P.time(p), endTime: P.endTime(p),
            location: `${P.location(p)}${addr ? ', ' + addr : ''}, ${town}, ON`,
            details, uid: P.id(p)
        };
    }
    const utcStamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

    function googleCalUrl(ev) {
        const q = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates: `${utcStamp(ev.start)}/${utcStamp(ev.end)}`, details: ev.details, location: ev.location, ctz: 'America/Toronto' });
        return `https://calendar.google.com/calendar/render?${q}`;
    }
    function outlookCalUrl(ev) {
        const q = new URLSearchParams({ rru: 'addevent', subject: ev.title, startdt: new Date(ev.start).toISOString(), enddt: new Date(ev.end).toISOString(), body: ev.details, location: ev.location });
        return `https://outlook.live.com/calendar/0/action/compose?${q}`;
    }
    // VTIMEZONE for America/Toronto so Calendar apps show the wall-clock time,
    // not a "(GMT)" conversion. Wall-clock DTSTART/DTEND come straight from the
    // program's date + time strings; only DTSTAMP is UTC.
    const VTIMEZONE = [
        'BEGIN:VTIMEZONE', 'TZID:America/Toronto',
        'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'END:STANDARD',
        'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'END:DAYLIGHT',
        'END:VTIMEZONE'
    ];
    const localStamp = (dateKey, hhmm) => `${dateKey.replace(/-/g, '')}T${String(hhmm || '00:00').replace(':', '').padStart(4, '0')}00`;
    function icsText(ev) {
        const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
        const endDate = ev.endTime && ev.endTime <= ev.startTime ? SkateTime.addDays(ev.date, 1) : ev.date;   // crosses midnight
        return [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Toronto Skating//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
            ...VTIMEZONE,
            'BEGIN:VEVENT',
            `UID:${ev.uid}@toronto-skating`,
            `DTSTAMP:${utcStamp(Date.now())}`,
            `DTSTART;TZID=America/Toronto:${localStamp(ev.date, ev.startTime)}`,
            `DTEND;TZID=America/Toronto:${ev.endTime ? localStamp(endDate, ev.endTime) : localStamp(ev.date, ev.startTime)}`,
            `SUMMARY:${esc(ev.title)}`,
            `LOCATION:${esc(ev.location)}`,
            `DESCRIPTION:${esc(ev.details)}`,
            `URL:${baseUrl()}#p=${ev.uid}`,
            'END:VEVENT', 'END:VCALENDAR'
        ].join('\r\n');
    }
    const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = () => /Android/i.test(navigator.userAgent);
    const isApple = () => isIOS() || (/Macintosh/.test(navigator.userAgent) && !isAndroid());

    /** The home server pre-builds one .ics per session under the favourites id (dell-nix skate-data). */
    function icsUrl(p) {
        const base = SkateAPI.icsBase ? SkateAPI.icsBase() : null;
        return base ? `${base}/${P.id(p)}.ics` : null;
    }

    /** A readable file name: "Leisure Skate - Malvern Recreation Centre - Sep 15.ics". */
    function icsFileName(p) {
        const day = P.dateStr(p) ? parseLocalDate(P.dateStr(p)).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
        return `${P.activity(p)} - ${P.location(p)}${day ? ' - ' + day : ''}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) + '.ics';
    }
    function saveBlob(blob, name) {
        const a = el('a', { href: URL.createObjectURL(blob), download: name });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

    /**
     * The .ics path, without new tabs where the platform allows it:
     *  - iPhone/iPad in Safari: navigate this tab to the https file; Safari
     *    shows the "Add All" preview and Done brings the page back.
     *  - The home-screen app: any file outside the app would open Safari, so
     *    hand the file to the share sheet instead (Calendar, Files, Mail…);
     *    if the share sheet is unavailable, fall back to opening Safari.
     *  - Everything else: fetch the file and save it, no tab at all.
     * data: and blob: pages are refused as top-level pages on iOS, which is
     * why the home server builds real https files.
     */
    async function openIcs(p) {
        const url = icsUrl(p);
        if (isIOS()) {
            if (isStandalone()) {
                try {
                    const blob = url ? await (await fetch(url, { cache: 'no-store' })).blob() : new Blob([icsText(calEvent(p))], { type: 'text/calendar' });
                    const file = new File([blob], icsFileName(p), { type: 'text/calendar' });
                    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: `${P.activity(p)} at ${P.location(p)}` }); return; }
                } catch (e) { if (e && e.name === 'AbortError') return; /* sheet dismissed */ }
                if (url) { window.open(url, '_blank', 'noopener'); return; }
                return downloadIcs(p);
            }
            if (url) { window.location.assign(url); return; }
            return downloadIcs(p);
        }
        if (url) {
            try {
                const r = await fetch(url, { cache: 'no-store' });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                saveBlob(await r.blob(), icsFileName(p));
                SkateUI.toast('Calendar file saved. Open it to add the session.', 'success', 2500);
                return;
            } catch (e) { /* home server unreachable: build the file here */ }
        }
        downloadIcs(p);
    }

    function downloadIcs(p) {
        const ev = calEvent(p);
        if (!ev) return SkateUI.toast('This session has no date to add', 'error');
        const blob = new Blob([icsText(ev)], { type: 'text/calendar;charset=utf-8' });
        if (isIOS()) {
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            return;
        }
        saveBlob(blob, icsFileName(p));
        SkateUI.toast('Calendar file saved. Open it to add the session.', 'success', 2500);
    }
    function openCalendarLink(p, kind) {
        const ev = calEvent(p);
        if (!ev) return SkateUI.toast('This session has no date to add', 'error');
        window.open(kind === 'outlook' ? outlookCalUrl(ev) : googleCalUrl(ev), '_blank', 'noopener');
    }

    /* ================= Render pipeline ================= */
    const Render = {};

    /** Generate every previously-hardcoded repeated structure from config. */
    Render.bootstrap = function () {
        // View tabs (rebuilt whenever section visibility changes)
        Render.tabs();
        $('view-tabs').onclick = e => {
            const t = e.target.closest('.view-tab');
            if (t) Actions.switchView(t.dataset.view);
        };

        // Unseen release → dot on ⚙️ (What's new lives in Settings now)
        $('settings-dot').classList.toggle('hidden', SkateSettings.get('lastSeenVersion') === CFG.version);


        // Chat filter chips (muted chip starts hidden, like before)
        chips($('chat-filters'), CFG.chatFilters, {
            attr: 'cf', active: 'all',
            onPick: id => { S.chatFilter = id; if (chatBooted) Render.conversations(SkateChat.getState()); },
            extra: (btn, it) => { if (it.dynamic) btn.classList.add('hidden'); }
        });

        // Guide category chips + write-form select
        const cats = CFG.guideCategories;
        const catItems = [{ id: '', label: 'All' }, ...Object.entries(cats).map(([k, c]) => ({ id: k, label: `${c.emoji} ${c.name}` }))];
        chips($('guide-cat-filters'), catItems, {
            attr: 'cat', active: '',
            onPick: id => { S.guideCat = id; Render.guides(); }
        });
        fillSelect($('guide-cat-input'), Object.entries(cats).map(([k, c]) => ({ value: k, label: `${c.emoji} ${c.name}` })), v => v.label);

        // Settings segments
        const seg = (host, items, attr) => {
            host.innerHTML = '';
            items.forEach(it => host.appendChild(el('button', { dataset: { [attr]: it.id } }, [it.seg || it.label])));
        };
        seg($('settings-timefmt'), CFG.timeFormats, 'fmt');
        seg($('settings-theme'), CFG.themes, 'theme');
        seg($('settings-sections'), CFG.sectionToggles, 'vis');
        seg($('settings-privacy'), CFG.privacyToggles, 'priv');

        Render.pills();
    };

    Render.switchView = function (view) {
        $$('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
        $$('.view-panel').forEach(p => p.classList.remove('active'));
        $(view + '-panel').classList.add('active');
    };

    /* ---------- Section visibility (Settings → Sections) ---------- */
    const viewVisible = v => !v.visKey || SkateSettings.get(v.visKey) !== false;

    /** All tabs are always in the DOM (their badge elements are referenced
     *  elsewhere) — hidden sections just get the .hidden class. */
    Render.tabs = function () {
        const tabs = $('view-tabs');
        const current = document.querySelector('.view-panel.active')?.id.replace('-panel', '') || 'programs';
        tabs.innerHTML = '';
        CFG.views.forEach(v => {
            const btn = el('button', {
                class: 'view-tab' + (v.id === current ? ' active' : '') + (viewVisible(v) ? '' : ' hidden'),
                dataset: { view: v.id }
            }, [v.label + (v.badgeId ? ' ' : '')]);
            if (v.badgeId) btn.appendChild(el('span', { class: 'badge hidden', id: v.badgeId }, ['0']));
            tabs.appendChild(btn);
        });
    };

    /* ---------- Rink scope (personalization) ---------- */
    /** Upcoming sessions at a location split by Paid, ignoring sessions the
     *  City's live schedule dropped — so a paid-only rink (Markham, Canlan)
     *  can say "12 paid" instead of a misleading "0 sessions". */
    // v3.10.2: every rink's count from ONE pass over the schedule, kept for the minute.
    // It used to be one full pass per rink row, so each keystroke in the rink search
    // walked the schedule up to 80 times (the lag while typing).
    let rinkCountCache = { stamp: '', map: new Map() };
    function rinkCounts(nowMs = Date.now()) {
        const stamp = `${S.programs.length}|${Math.floor(nowMs / 60000)}|${SkateAlerts.liveCheckedAt || ''}`;
        if (rinkCountCache.stamp === stamp) return rinkCountCache.map;
        const map = new Map();
        S.programs.forEach(p => {
            if (SkateTime.status(p, nowMs).phase === 'ended' || SkateAlerts.isDropped(p)) return;
            const k = P.locKey(p);
            let e = map.get(k);
            if (!e) map.set(k, e = { free: 0, paid: 0 });
            if (p.Paid) e.paid++; else e.free++;
        });
        rinkCountCache = { stamp, map };
        return map;
    }
    const NO_SESSIONS = Object.freeze({ free: 0, paid: 0 });
    function upcomingSplit(key, nowMs = Date.now()) {
        return rinkCounts(nowMs).get(key) || NO_SESSIONS;
    }

    /* ---------- Other names of a rink (v3.12) ----------
     * rinks.json carries `aka`: "College Park" is also the Barbara Ann Scott Ice
     * Trail. Both find the rink in either search box; the first one is shown
     * beside the name. One lowercase string per rink, built once per rink list. */
    let akaSrc = null;
    const akaCache = new Map();
    function akaOf(key) {
        if (akaSrc !== SkateGeo.rinks) { akaSrc = SkateGeo.rinks; akaCache.clear(); }
        let hit = akaCache.get(key);
        if (hit === undefined) {
            const r = SkateGeo.rinkByLocation(key);
            const list = r && Array.isArray(r.aka) ? r.aka.filter(x => typeof x === 'string' && x.trim()) : [];
            hit = { first: list[0] || '', hay: list.join(' | ').toLowerCase() };
            akaCache.set(key, hit);
        }
        return hit;
    }
    /** "Opens Dec 12" / "Not open yet" / "Closed for the season" for a seasonal rink that is not open, else ''. */
    function seasonWord(r, today = SkateTime.todayKey()) {
        const s = r && r.seasonal;
        if (!s || typeof s !== 'object' || s.state === 'ok' || s.state === 'failed') return '';
        if (s.state === 'pending') return (/^\d{4}-\d{2}-\d{2}$/.test(s.from || '') && s.from > today) ? `Opens ${parseLocalDate(s.from).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}` : 'Not open yet';
        if (s.state === 'closed') return 'Closed for the season';
        if (s.state === 'shut') return 'Closed right now';
        if (s.state === 'dormant') return 'Out of season';
        return '';
    }
    /** A rink that has a season and is not open right now (free-skate lines for it stay hidden). */
    const rinkShut = (key) => !!seasonWord(SkateGeo.rinkByLocation(key));

    /* ---------- Active filters as removable pills ---------- */
    const SUB_LABEL = id => (CFG.subTypes.find(x => x.id === id) || {}).label || id;
    const CAT_LABEL = id => (CFG.programTypes.find(x => x.id === id) || {}).label || id;
    const DAY_LABEL = d => d === 'today' ? 'Today' : d === 'tomorrow' ? 'Tomorrow' : d === 'weekend' ? 'Weekend' : (d || '').slice(0, 3);

    /** Everything currently narrowing the list, in pill form (key → label). */
    function activeFilterPills() {
        const pills = [];
        Object.entries(S.types).forEach(([cat, sel]) => {
            if (OTHER_GROUP.includes(cat)) return;   // folded into the one Other pill below
            const parts = [];
            if (cat === 'hockey' && Array.isArray(S.kinds) && S.kinds.length) parts.push(S.kinds.length === 1 ? KIND_OF(S.kinds[0]).short : `${KIND_OF(S.kinds[0]).short} +${S.kinds.length - 1}`);
            if (sel !== 'all') parts.push(sel.length === 1 ? SUB_LABEL(sel[0]) : `${SUB_LABEL(sel[0])} +${sel.length - 1}`);
            pills.push({ key: `type:${cat}`, label: `${CAT_LABEL(cat)}${parts.length ? ': ' + parts.join(', ') : ''}`, ages: subsPresentFor(cat).length > 1 || (cat === 'hockey' && kindsPresent().length > 1) });
        });
        const present = otherMembersAll();
        const onMembers = present.filter(c => S.types[c]);
        if (onMembers.length) {
            const partial = onMembers.length < present.length;
            const label = !partial ? 'Other' : onMembers.length <= 2 ? `Other: ${onMembers.map(CAT_LABEL).join(', ')}` : `Other: ${onMembers.length} of ${present.length}`;
            pills.push({ key: `type:${OTHER_KEY}`, label, ages: present.length > 1 });
        }
        if (S.day) pills.push({ key: 'day', label: DAY_LABEL(S.day) });
        if (S.dateFrom) pills.push({ key: 'dates', label: rangeLabel(S.dateFrom, S.dateTo) });
        if (S.age !== null) pills.push({ key: 'age', label: `${S.age} years old` });
        if (S.savedOnly) pills.push({ key: 'saved', label: 'Saved only' });
        if (S.nearRink) pills.push({ key: 'near', label: `Only ${S.nearRink.name}` });
        if (S.showPast) pills.push({ key: 'past', label: 'Ended shown' });
        if (S.showDropped) pills.push({ key: 'dropped', label: 'Dropped shown' });
        if (S.sort === 'near') pills.push({ key: 'sort', label: 'Nearest first' });
        if (S.radius && SkateGeo.getUserLocation()) pills.push({ key: 'radius', label: `Within ${S.radius} km`, menu: 'radius' });
        return pills;
    }

    // v3.16: the colours of the kinds folded into Other (as on the cards), warm to cool
    const OTHER_HUES = { speed: '#a68b52', other: '#b98a52', ringette: '#b35f9a', adapted: '#8a6cb8' };   // v3.17: the softer kind colours
    /** Other's pill: a blend of the kinds it holds right now (one kind = its colour alone). */
    function paintOther(b) {
        const on = Object.keys(OTHER_HUES).filter(c => S.types[c]);
        const cols = (on.length ? on : Object.keys(OTHER_HUES)).map(c => OTHER_HUES[c]);
        const stops = (f) => (cols.length === 1 ? [cols[0], cols[0]] : cols).map(f).join(', ');
        b.style.setProperty('--mix-bg', `linear-gradient(100deg, ${stops(c => `color-mix(in srgb, ${c} var(--tint), var(--bg-white))`)})`);
        b.style.setProperty('--mix-line', `linear-gradient(100deg, ${stops(c => c)})`);
    }

    /** "Toronto" / "Toronto + 2" / "All cities" for the standing city pill. */
    function cityPillLabel() {
        if (!S.cities.length) return 'All cities';
        const [first, ...rest] = S.cities;
        return rest.length ? `${first} + ${rest.length}` : first;
    }

    Render.pills = function () {
        const wrap = $('active-filters');
        wrap.innerHTML = '';
        // Standing city picker: always there. Tap = choose cities, x = every city.
        const cityPill = el('button', {
            class: 'pill city' + (S.cities.length ? ' on' : ''), dataset: { pill: 'cities' },
            title: S.cities.length ? 'Tap to change cities. The x shows every city.' : 'Tap to choose cities'
        }, [el('span', { class: 'pill-label' }, [cityPillLabel()]), el('span', { class: 'pill-caret', 'aria-hidden': 'true' }, ['▾'])]);
        if (S.cities.length) cityPill.appendChild(el('span', { class: 'pill-x', role: 'button', 'aria-label': 'Show every city', title: 'Show every city' }, ['✕']));
        wrap.appendChild(cityPill);
        const mine = (SkateSettings.get('myRinks') || []).length;
        if (mine) {
            // a standing toggle, not a removable pill: regulars flip it daily
            const on = S.rinkScope === 'mine';
            wrap.appendChild(el('button', {
                class: 'pill toggle' + (on ? ' active' : ''), dataset: { pill: 'mine' },
                title: on ? 'Showing only your rinks. Tap for every rink.' : 'Tap to show only your rinks'
            }, [`${on ? '★' : '☆'} My rinks (${mine})`]));
        }
        const pills = activeFilterPills();
        pills.forEach(pl => {
            // v3.16: a kind's pill wears its colour from the cards; Other blends the kinds it holds
            const kind = pl.key.startsWith('type:') ? pl.key.slice(5) : '';
            const kindCls = kind ? ` type k-${kind === OTHER_KEY ? 'mix' : kind}` : '';
            if (pl.ages) {
                // type pill: tap = choose age groups, x = drop the type
                const b = el('button', { class: 'pill' + kindCls, dataset: { pill: pl.key }, title: 'Tap to choose age groups. The x removes this type.' }, [
                    el('span', { class: 'pill-label' }, [pl.label]),
                    el('span', { class: 'pill-caret', 'aria-hidden': 'true' }, ['▾']),
                    el('span', { class: 'pill-x', role: 'button', 'aria-label': `Remove ${pl.label}`, title: 'Remove this type' }, ['✕'])
                ]);
                if (kind === OTHER_KEY) paintOther(b);
                wrap.appendChild(b);
                return;
            }
            if (pl.menu === 'radius') {
                // v3.12: tap = pick another distance, x = any distance
                wrap.appendChild(el('button', { class: 'pill radius', dataset: { pill: pl.key }, title: 'Tap to change the distance. The x shows every distance.' }, [
                    el('span', { class: 'pill-label' }, [pl.label]),
                    el('span', { class: 'pill-caret', 'aria-hidden': 'true' }, ['▾']),
                    el('span', { class: 'pill-x', role: 'button', 'aria-label': 'Any distance', title: 'Any distance' }, ['✕'])
                ]));
                return;
            }
            const plain = el('button', { class: 'pill' + (pl.key === 'near' ? ' rink' : '') + kindCls, dataset: { pill: pl.key }, title: 'Remove this filter' }, [
                pl.label, el('span', { class: 'pill-x', 'aria-hidden': 'true' }, ['✕'])
            ]);
            if (kind === OTHER_KEY) paintOther(plain);
            wrap.appendChild(plain);
        });
        const n = pills.length + (S.rinkScope === 'mine' && mine ? 1 : 0) + (S.cities.length ? 1 : 0);
        $('filters-count').textContent = String(n);
        $('filters-count').classList.toggle('hidden', !n);
        $('btn-filters').classList.toggle('active', !!n);
        $('btn-list').classList.toggle('active', !S.calMode);
        $('btn-list').setAttribute('aria-pressed', S.calMode ? 'false' : 'true');
        $('btn-cal').classList.toggle('active', S.calMode);
        $('btn-cal').setAttribute('aria-pressed', S.calMode ? 'true' : 'false');
        // v3.12: which calendar the button opens, as a colour (the ▾ beside it switches)
        const ct = calType();
        $('view-seg').dataset.cal = ct;
        $('btn-cal').title = `Calendar: ${(CFG.calTypes.find(t => t.id === ct) || {}).label || 'week grid'}. The ▾ switches calendars.`;
        $('btn-cal-type').classList.toggle('active', S.calMode);
        $('btn-free').setAttribute('aria-checked', S.paidVisible ? 'false' : 'true');
        $('btn-free').title = S.paidVisible ? 'Showing everything with prices. Tap for free sessions only.' : 'Showing free sessions only. Tap to show paid ones too.';
    };

    /* ---------- Filters sheet ---------- */
    /** Counts by category / sub-type / city over the dataset (dropped City sessions excluded unless shown). */
    /**
     * The Filters sheet's numbers (v3.14: they follow your other filters). The kinds and their
     * ages count what they would show with your cities, Free only, the day, the search, your
     * rinks, the distance and your age as they are now; the cities count with your kinds and
     * the rest. `paid` is how many paid sessions Free only hides. Cached per filter state.
     */
    let facetMemo = null;
    const facetKey = () => [S.programs.length, S.programs.length ? S.programs[0]._id : '', JSON.stringify(S.types), JSON.stringify(S.kinds), S.cities.join(','),
        S.day, S.dateFrom, S.dateTo, S.age, S.savedOnly ? SkateFavorites.count() : '', S.rinkScope, (SkateSettings.get('myRinks') || []).join(','), S.nearRink ? S.nearRink.key : '',
        S.radius, (SkateGeo.getUserLocation() || {}).ts, S.search, S.showPast, S.showDropped, S.paidVisible, SkateAlerts.checkedAt, Math.floor(Date.now() / 60000)].join('\u0001');
    function filterFacets() {
        const key = facetKey();
        if (facetMemo && facetMemo.key === key) return facetMemo.f;
        const c = filterChecks();
        const cats = {}, cities = {};
        let paid = 0;
        for (const p of S.programs) {
            if (!c.rest(p)) continue;
            const t = c.type(p), ci = c.city(p), pv = c.paid(p);
            if (ci && pv) {
                const k = P.category(p), st = P.subType(p);
                const f = (cats[k] ||= { n: 0, subs: {} });
                f.n++;
                f.subs[st] = (f.subs[st] || 0) + 1;
                if (k === 'hockey') {
                    const kd = P.hockeyKind(p);
                    (f.kinds ||= {})[kd] = (f.kinds[kd] || 0) + 1;
                    const by = ((f.subsBy ||= {})[kd] ||= {});            // the ages inside each kind
                    by[st] = (by[st] || 0) + 1;
                }
            }
            else if (ci && !pv) {                                    // v3.15.1: what Free only is hiding, per kind
                const k = P.category(p), f = (cats[k] ||= { n: 0, subs: {} });
                f.paidHidden = (f.paidHidden || 0) + 1;
                if (k === 'hockey') { const kd = P.hockeyKind(p); (f.kindsPaid ||= {})[kd] = (f.kindsPaid[kd] || 0) + 1; }
            }
            if (t && pv) { const city = P.city(p); cities[city] = (cities[city] || 0) + 1; }
            if (t && ci && p.Paid) paid++;
        }
        const f = { cats, cities, paid };
        facetMemo = { key, f };
        return f;
    }
    /** Cities as offered: those with sessions under your other filters, and any already picked. */
    /* v3.15: what the data holds at all, whatever the filters. Every city and every kind of skating in
       it is always offered (at 0 when your other filters leave nothing there): hiding them made
       Richmond Hill, Mississauga and the rest vanish from the city list whenever Free only was on. */
    let inDataMemo = null;
    const inData = () => {
        if (!inDataMemo || inDataMemo.of !== S.programs) {
            const cities = new Set(), cats = new Set(), ages = new Map(), kindAges = new Map();
            const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
            S.programs.forEach(p => {
                const c = P.category(p), st = P.subType(p);
                cities.add(P.city(p)); cats.add(c); add(ages, c, st);
                if (c === 'hockey') add(kindAges, P.hockeyKind(p), st);
            });
            inDataMemo = { of: S.programs, cities, cats, ages, kindAges };
        }
        return inDataMemo;
    };
    /** Cities as offered: every city in the data (and any picked), each with what your other filters leave there. */
    const citiesShown = (f) => { const o = {}; [...inData().cities, ...S.cities].forEach(c => { o[c] = f.cities[c] || 0; }); return o; };
    const cityKeys = (cities) => Object.keys(cities).sort((a, b) => {
        const ia = CFG.cityOrder.indexOf(a), ib = CFG.cityOrder.indexOf(b);
        return ((ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)) || a.localeCompare(b);
    });
    /** The age groups a kind of skating has in the data at all (v3.15.2: not only those left after your other filters). */
    const subsPresentFor = (cat) => CFG.subTypes.map(x => x.id).filter(id => (inData().ages.get(cat) || new Set()).has(id));
    /* v3.12.2: the kinds of hockey in this dataset, in their set order */
    const KIND_OF = (id) => CFG.hockeyKinds.find(k => k.id === id) || { id, label: id, short: id };
    /* v3.15: the kinds of hockey in the data at all, whatever the other filters: both are always offered
       under Hockey (with Toronto alone, Stick & puck reads 0; hiding it made the choice vanish). */
    let kindsMemo = null;
    const kindsPresent = () => {
        if (!kindsMemo || kindsMemo.of !== S.programs) {
            const seen = new Set();
            for (const p of S.programs) { if (P.category(p) === 'hockey') { seen.add(P.hockeyKind(p)); if (seen.has('pickup') && seen.has('stickpuck')) break; } }
            kindsMemo = { of: S.programs, list: CFG.hockeyKinds.map(k => k.id).filter(id => id !== 'other' && seen.has(id)) };
        }
        return kindsMemo.list;
    };
    /** The one hockey kind picked, or '' for any (v3.12.3). */
    const kindNow = () => (S.types.hockey && Array.isArray(S.kinds) && S.kinds.length === 1 ? S.kinds[0] : '');
    /** A category's age counts: for hockey with one kind ticked, the ages inside that kind. */
    const ageCounts = (cat, facet) => (cat === 'hockey' && kindNow() ? ((facet.subsBy || {})[kindNow()] || {}) : (facet.subs || {}));
    /** The age groups worth offering: those with sessions (in the kind picked), and any already picked. */
    const agesShown = (cat, facet) => {
        // v3.15.2: every age group the kind has in the data (for hockey with one kind ticked, that kind's),
        // whatever your other filters leave: Figure's Adult group vanished whenever Toronto or Free only left none.
        // Only a group the kind never has is not offered; one already picked always is.
        const sel = S.types[cat], known = (cat === 'hockey' && kindNow() ? inData().kindAges.get(kindNow()) : inData().ages.get(cat)) || new Set();
        return CFG.subTypes.filter(x => known.has(x.id) || (Array.isArray(sel) && sel.includes(x.id)));
    };
    const subMenuTitle = (cat) => (cat === 'hockey' && kindsPresent().length > 1 ? 'Hockey: kind and age' : CAT_LABEL(cat) + ': age groups');

    // The everyday kinds sit first; everything else is one "Other" group
    // (its members stay separate categories in S.types, the group is just
    // how the sheet and the pill present them).
    const MAIN_TYPES = ['leisure', 'figure', 'hockey'];
    const OTHER_GROUP = ['other', 'adapted', 'ringette', 'speed'];
    const OTHER_KEY = '__other';
    const otherMembersPresent = () => { const f = filterFacets().cats; return OTHER_GROUP.filter(c => f[c]); };
    /* v3.14: the Other kinds in the data at all, whatever the other filters. Turning Other on or off
       moves all of them, so a city picked later never finds half of Other switched off. */
    let otherAllMemo = null;
    const otherMembersAll = () => {
        if (!otherAllMemo || otherAllMemo.of !== S.programs) { const seen = new Set(S.programs.map(p => P.category(p))); otherAllMemo = { of: S.programs, list: OTHER_GROUP.filter(c => seen.has(c)) }; }
        return otherAllMemo.list;
    };

    Render.filters = function () {
        const f = filterFacets();
        const body = $('filters-body');
        body.innerHTML = '';
        const section = (title) => { const sec = el('div', { class: 'fsec' }); if (title) sec.appendChild(el('h4', {}, [title])); body.appendChild(sec); return sec; };
        const check = (label, on, dataset, cls = '') => {
            const input = el('input', { type: 'checkbox', dataset });
            input.checked = !!on;
            return el('label', { class: 'fcheck' + cls }, [input, el('span', { class: 'fcheck-label' }, [label])]);
        };
        const count = (n) => el('span', { class: 'fcount' }, [String(n)]);
        const chip = (label, on, dataset) => el('button', { class: 'fchip' + (on ? ' active' : ''), dataset, 'aria-pressed': on ? 'true' : 'false' }, Array.isArray(label) ? label : [label]);
        const foldBtn = (key, open, label) => el('button', { class: 'ftoggle' + (open ? ' open' : ''), dataset: { expand: key }, 'aria-expanded': open ? 'true' : 'false' }, [label, el('span', { class: 'caret', 'aria-hidden': 'true' }, ['▾'])]);

        /** A label that says what Free only hides there ("Stick & puck +4 paid"), so a 0 is not a mystery (v3.15.1). */
        const withPaid = (text, m) => (!S.paidVisible && m ? el('span', {}, [text, el('span', { class: 'fpaid' }, [`+${m} paid`])]) : text);
        /** One category row (+ its age groups) appended to `host`. */
        const typeRow = (cat, host) => {
            const facet = f.cats[cat.id] || (S.types[cat.id] || inData().cats.has(cat.id) ? { n: 0, subs: {} } : null);   // v3.15: always offered, 0 if nothing is left
            if (!facet) return;                                     // nothing of it under your other filters (v3.14: picked ones stay, at 0)
            const sel = S.types[cat.id];
            const subsPresent = agesShown(cat.id, facet);
            const ageN = ageCounts(cat.id, facet);
            const kindsHere = cat.id === 'hockey' ? CFG.hockeyKinds.filter(k => kindsPresent().includes(k.id)) : [];
            const hasKinds = kindsHere.length > 1, hasAges = subsPresent.length > 1;
            const hasSubs = hasAges || hasKinds;
            const what = hasKinds ? (hasAges ? 'Kind & ages' : 'Kind') : 'Ages';
            const pick = S.expandedCats[cat.id];   // undefined = auto, true/false = the reader's last tap
            const narrowed = !!sel && (sel !== 'all' || (hasKinds && Array.isArray(S.kinds)));
            const open = hasSubs && (pick === true || (pick !== false && narrowed));
            const row = el('div', { class: `fcat type-${cat.id}` + (sel ? ' on' : '') });
            row.appendChild(check(withPaid(cat.label, facet.paidHidden), !!sel, { type: cat.id }, ' cat'));
            row.appendChild(count(facet.n));
            if (hasSubs) row.appendChild(el('button', { class: 'fexpand' + (open ? ' open' : ''), dataset: { expand: cat.id }, title: open ? `Hide the ${what.toLowerCase()}` : `Choose ${what.toLowerCase()}`, 'aria-expanded': open ? 'true' : 'false' }, [what + ' ', el('span', { class: 'caret', 'aria-hidden': 'true' }, ['▾'])]));
            else row.appendChild(el('span', { class: 'fexpand-spacer', 'aria-hidden': 'true' }));   // keeps the counts in one column
            host.appendChild(row);
            if (hasSubs) {
                const subs = el('div', { class: 'fsubs' + (open ? '' : ' hidden') });
                if (hasKinds) {
                    // v3.14: ticks like everything else. Hockey on ticks both; untick one to hide its sessions.
                    subs.appendChild(el('div', { class: 'fsubs-head' }, ['Kind']));
                    kindsHere.forEach(k => {
                        const c = check(withPaid(k.label, (facet.kindsPaid || {})[k.id]), !!sel && (!Array.isArray(S.kinds) || S.kinds.includes(k.id)), { kind: k.id });
                        c.appendChild(count((facet.kinds || {})[k.id] || 0));
                        subs.appendChild(c);
                    });
                    if (hasAges) subs.appendChild(el('div', { class: 'fsubs-head' }, [kindNow() ? `Ages in ${KIND_OF(kindNow()).label.toLowerCase()}` : 'Ages']));
                }
                if (hasAges) subsPresent.forEach(x => {
                    const on = sel === 'all' || (Array.isArray(sel) && sel.includes(x.id));
                    const c = check(x.label, !!sel && on, { type: cat.id, sub: x.id });
                    c.appendChild(count(ageN[x.id] || 0));
                    subs.appendChild(c);
                });
                host.appendChild(subs);
            }
        };

        // WHAT: leisure, figure, hockey, then Other (one row that groups the rest)
        const t = section('What kind of skating');
        CFG.programTypes.filter(c => MAIN_TYPES.includes(c.id)).forEach(c => typeRow(c, t));
        const members = CFG.programTypes.filter(c => OTHER_GROUP.includes(c.id) && (f.cats[c.id] || S.types[c.id] || inData().cats.has(c.id)));
        if (members.length) {
            const onMembers = members.filter(c => S.types[c.id]);
            const anyOn = onMembers.length > 0, allOn = onMembers.length === members.length;
            const pickO = S.expandedCats[OTHER_KEY];
            const open = pickO === true || (pickO !== false && anyOn && !allOn);
            const row = el('div', { class: `fcat type-other group` + (anyOn ? ' on' : '') });
            const box = check('Other', anyOn, { type: OTHER_KEY }, ' cat');
            box.querySelector('input').indeterminate = anyOn && !allOn;
            box.title = members.map(c => c.label).join(', ');
            row.appendChild(box);
            row.appendChild(count(members.reduce((n, c) => n + (f.cats[c.id] ? f.cats[c.id].n : 0), 0)));
            row.appendChild(el('button', { class: 'fexpand' + (open ? ' open' : ''), dataset: { expand: OTHER_KEY }, title: open ? 'Hide the kinds' : 'Choose kinds', 'aria-expanded': open ? 'true' : 'false' }, ['Kinds ', el('span', { class: 'caret', 'aria-hidden': 'true' }, ['▾'])]));
            t.appendChild(row);
            const subs = el('div', { class: 'fsubs' + (open ? '' : ' hidden') });
            members.forEach(c => { const cb = check(c.label, !!S.types[c.id], { type: c.id }); cb.appendChild(count(f.cats[c.id] ? f.cats[c.id].n : 0)); subs.appendChild(cb); });
            t.appendChild(subs);
        }

        // YOUR AGE: visible, not folded — the most-asked question after "when"
        const ageSec = section('Your age');
        const ageInput = el('input', { type: 'number', min: '0', max: '120', id: 'f-age', placeholder: 'Any age', inputmode: 'numeric', 'aria-label': 'Your age in years', title: 'Keeps only the sessions a person of this age can join' });
        if (S.age !== null) ageInput.value = S.age;
        ageSec.appendChild(el('div', { class: 'fage-row' }, [
            el('label', { class: 'fage-box', for: 'f-age' }, [ageInput, el('span', { class: 'fage-unit', 'aria-hidden': 'true' }, ['years old'])]),
            ...(S.age !== null ? [el('button', { class: 'flink', dataset: { clearAge: '1' } }, ['Any age'])] : [])
        ]));

        // WHEN
        const w = section('When');
        const days = el('div', { class: 'fchips' });
        [['', 'Any day'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['weekend', 'Weekend'], ...CFG.days.map(d => [d, d.slice(0, 3)])]
            .forEach(([id, label]) => days.appendChild(chip(label, S.day === id && !(id === '' && S.dateFrom), { day: id })));
        if (S.dateFrom) days.appendChild(chip(`${rangeLabel(S.dateFrom, S.dateTo)} ✕`, true, { dates: 'clear' }));   // v3.16: from the bar's date picker
        w.appendChild(days);

        // WHERE
        const where = section('Where');
        const cityRow = el('div', { class: 'fchips' });
        cityRow.appendChild(chip('All cities', !S.cities.length, { city: '' }));
        const shownCities = citiesShown(f);
        cityKeys(shownCities).forEach(c => cityRow.appendChild(chip(`${c} · ${shownCities[c]}`, S.cities.includes(c), { city: c })));
        where.appendChild(cityRow);
        const mine = (SkateSettings.get('myRinks') || []).length;
        const mineRow = check(`My rinks only${mine ? ` (${mine})` : ''}`, S.rinkScope === 'mine', { flag: 'mine' });
        mineRow.appendChild(el('button', { class: 'flink', dataset: { open: 'rinks' } }, [mine ? 'Edit' : 'Pick rinks']));
        where.appendChild(mineRow);
        // v3.15.3: Distance and Order out in the open, under Where (they were folded under More options)
        // v3.12: only what is within N km of your spot (a filter, unlike Nearest, which only reorders)
        const far = el('div', { class: 'fchips fradius' }, [el('span', { class: 'flabel' }, ['Distance'])]);
        const hasSpot = !!SkateGeo.getUserLocation();
        far.appendChild(chip('Any', !S.radius || !hasSpot, { radius: '' }));
        CFG.radiusOptions.forEach(km => far.appendChild(chip(`${km} km`, hasSpot && S.radius === km, { radius: String(km) })));
        where.appendChild(far);
        const ord = el('div', { class: 'fchips forder' }, [el('span', { class: 'flabel' }, ['Order'])]);
        CFG.sortOptions.forEach(x => ord.appendChild(chip(x.label, S.sort === x.id, { sort: x.id })));
        where.appendChild(ord);
        if (S.sort === 'near' && !hasSpot) where.appendChild(el('p', { class: 'settings-hint' }, ['Nearest needs your location. Set it under Rinks and map.']));
        // v3.15.2: Free only is the switch in the sheet's header; it says how many paid sessions it hides
        $('f-free').checked = !S.paidVisible;
        $('f-free-sub').textContent = !S.paidVisible && f.paid ? `${f.paid} paid hidden` : '';
        $('f-free-sub').classList.toggle('hidden', !(!S.paidVisible && f.paid));

        // MORE: ended, saved-only, dropped (folded unless something in it is set)
        const inUse = S.showPast || S.savedOnly || S.showDropped;
        const openMore = S.moreFilters || inUse;
        const m = section('');
        m.appendChild(foldBtn('__filters', openMore, `${openMore ? 'Fewer' : 'More'} options: ended sessions, saved`));
        const mbody = el('div', { class: 'fmore' + (openMore ? '' : ' hidden') });
        mbody.appendChild(check('Include sessions that already ended', S.showPast, { flag: 'past' }));
        mbody.appendChild(check('Only sessions I saved', S.savedOnly, { flag: 'saved' }));
        const dropped = SkateAlerts.liveStats?.missing || 0;
        if (dropped) mbody.appendChild(check(`Include the ${dropped} City session${dropped === 1 ? '' : 's'} toronto.ca no longer lists`, S.showDropped, { flag: 'dropped' }));
        m.appendChild(mbody);

        Render.filtersCount();
    };

    Render.filtersCount = function () {
        const n = computeFiltered().length;
        $('btn-filters-apply').textContent = `Done · ${n} session${n === 1 ? '' : 's'}`;
    };

    /**
     * Calendar legend in words, limited to what the rendered week shows:
     * a reader with Leisure + Figure on should not see Hockey in the key.
     * `res` = SkateCalendar.render's result ({ types, states, total }).
     */
    Render.calLegend = function (res, mode = 'grid') {
        const present = res?.types || [], st = res?.states || {};
        const types = CFG.activityTags.filter(t => present.includes(t.cls)).map(t =>
            `<span class="legend-item"><span class="legend-dot ${t.cls}"></span>${escapeHtml(t.label)}</span>`
        ).join('');
        const states = [
            st.saved && '<span class="legend-item"><span class="legend-sample sample-saved"></span>saved</span>',
            st.paid && '<span class="legend-item"><span class="legend-sample sample-paid"></span>paid ($)</span>',
            st.closed && '<span class="legend-item"><span class="legend-sample sample-cancelled">✕</span>likely cancelled</span>',
            st.warning && '<span class="legend-item"><span class="legend-sample sample-warning"></span>service alert</span>',
            st.unverified && '<span class="legend-item"><span class="legend-sample sample-unverified"></span>unverified</span>'
        ].filter(Boolean).join('');
        $('cal-legend').innerHTML =
            (types ? `<span class="legend-group">${types}</span>` : '') +
            (states ? `<span class="legend-group">${states}</span>` : '') +
            `<span class="legend-hint">${!res?.total ? 'Nothing here with these filters.'
                : mode === 'planner' ? 'Every line is one session: the time, the rink, then kind, ages and price. Tap a line for details, the heart to save it.'
                : 'Tap a session for details and actions.'}</span>`;
    };

    /**
     * "Next saved session" countdown card — the schedule's answer to a
     * fridge note. Shows the soonest saved session that hasn't ended
     * (live ones first), ticking via the 1-minute refresh.
     */
    Render.savedNext = function () {
        const card = $('saved-next');
        const nowMs = Date.now();
        const rows = [];
        S.programs.forEach(p => {
            if (!SkateFavorites.has(p)) return;
            if (SkateAlerts.isDropped(p)) return;           // the City dropped it: no countdown to nothing
            const st = SkateTime.status(p, nowMs);
            if (st.phase === 'ended' || st.phase === 'undated') return;
            rows.push({ p, st });
        });
        if (!rows.length) { card.classList.add('hidden'); return; }
        rows.sort((a, b) => (a.st.phase === 'live' ? 0 : 1) - (b.st.phase === 'live' ? 0 : 1) || a.st.startEpoch - b.st.startEpoch);
        // every saved session on the soonest day, in order (the fridge note for that day)
        const day = P.dateStr(rows[0].p).slice(0, 10);
        const todayKey = SkateTime.todayKey(), tomorrowKey = SkateTime.addDays(todayKey, 1);
        const dayLabel = day === todayKey ? 'Today' : day === tomorrowKey ? 'Tomorrow'
            : parseLocalDate(day).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
        const onDay = rows.filter(r => P.dateStr(r.p).slice(0, 10) === day).sort((a, b) => a.st.startEpoch - b.st.startEpoch).slice(0, 5);
        // right column: what matters most right now (a cancelled rink beats a countdown)
        const state = (p, st) => {
            const a = SkateAlerts.forProgram(p);
            if (a && a.level === 'closed') return { cls: ' is-alert', txt: 'Likely cancelled' };
            if (st.phase === 'live') return { cls: ' is-live', txt: `On now · ${SkateTime.fmtMins(st.minsLeft)} left` };
            const soon = st.minsToStart < 24 * 60 ? `Starts in ${SkateTime.fmtMins(st.minsToStart)}` : '';
            return a && a.level !== 'note' ? { cls: ' is-warn', txt: `${soon ? soon + ' · ' : ''}rink alert` } : { cls: '', txt: soon };
        };
        const toMins = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
        const durOf = (p) => {
            const a = toMins(P.time(p)), b = toMins(P.endTime(p));
            return a == null || b == null ? '' : SkateTime.fmtMins(((b - a) + 1440) % 1440);
        };
        const count = onDay.length === rows.length
            ? `${rows.length} session${rows.length === 1 ? '' : 's'}`
            : `${onDay.length} of ${rows.length} saved`;
        card.classList.remove('hidden');
        card.classList.toggle('is-live', onDay[0].st.phase === 'live');
        card.innerHTML = `
            <div class="saved-next-head"><span class="saved-next-label">Saved · ${escapeHtml(dayLabel)}</span><span class="saved-next-count">${count}</span></div>
            ${onDay.map(({ p, st }) => {
                const { cls, txt } = state(p, st);
                const km = SkateGeo.distanceForProgram(p);
                const small = [durOf(p), km != null ? SkateGeo.fmtKm(km) : ''].filter(Boolean).join(' · ');
                const end = P.endTime(p);
                return `<button class="saved-row${cls}" data-pid="${P.id(p)}" title="Jump to this session">
                <span class="saved-row-when">${fmtClock(P.time(p))}${end ? '–' + fmtClock(end) : ''}${small ? `<small>${escapeHtml(small)}</small>` : ''}</span>
                <span class="saved-row-title"><span class="legend-dot ${P.typeCls(p) || ''}"></span>${escapeHtml(P.activity(p))} · ${escapeHtml(P.location(p))}</span>
                <span class="saved-row-state">${escapeHtml(txt)}</span>
            </button>`; }).join('')}`;
    };

    /** Saved sessions that have ended leave the list on their own (quietly). */
    function pruneEndedSaved(nowMs) {
        S.programs.forEach(p => {
            if (SkateFavorites.has(p) && SkateTime.status(p, nowMs).phase === 'ended') SkateFavorites.remove(p);
        });
    }

    /* ---------- Programs ---------- */
    /**
     * Data-health banners above the list: the whole site is CI-committed
     * static data, so if GitHub Actions ever silently dies, THIS is how
     * anyone finds out. Escalates loudly past 8 days (data refreshes
     * weekly, so >8d means at least one missed run), and surfaces any
     * external source that failed at the last pipeline run.
     */
    // Alert feed counts as delayed past this age. Budget: 15-min cron
    // (delayed up to ~1h under GitHub load) + 2h heartbeat + Pages deploy.
    const ALERTS_STALE_MS = 3.5 * 3600 * 1000;
    // The toronto.ca live-schedule cross-check runs on the same ticks; the
    // City can drop a session any time, so past this age the flags may lag.
    const LIVE_STALE_MS = 8 * 3600 * 1000;

    Render.dataWarnings = function (metadata, now) {
        const wrap = $('data-warnings');
        wrap.innerHTML = '';

        // Service-alert feed gone quiet? Say so BEFORE someone travels on
        // "no alerts shown" — that silence might be a dead checker, not a
        // healthy rink. (Aug 4 lesson.)
        if (SkateAlerts.loaded && SkateAlerts.checkedAt) {
            const ageMs = now - new Date(SkateAlerts.checkedAt);
            if (ageMs > ALERTS_STALE_MS) {
                const hrs = Math.round(ageMs / 3600000);
                wrap.innerHTML += `<div class="alert-banner warning">
                    <strong>Rink alerts were last checked about ${hrs} hours ago.</strong>
                    The checker may be delayed, so a rink could be closed without a banner here.
                    Confirm with the venue before travelling.
                </div>`;
            }
        }

        if (SkateAlerts.loaded && SkateAlerts.liveCheckedAt) {
            const ageMs = now - new Date(SkateAlerts.liveCheckedAt);
            if (ageMs > LIVE_STALE_MS) {
                const hrs = Math.round(ageMs / 3600000);
                wrap.innerHTML += `<div class="alert-banner warning">
                    <strong>The toronto.ca cross-check last ran about ${hrs} hours ago.</strong>
                    A session the City has since dropped could still be listed here. Use the toronto.ca link on a row to verify before travelling.
                </div>`;
            }
        }

        if (!metadata) return;

        if (metadata.lastUpdated) {
            const daysAgo = Math.floor((now - new Date(metadata.lastUpdated)) / 86400000);
            if (daysAgo > 8) {
                wrap.innerHTML += `<div class="alert-banner closed">
                    <strong>The schedule data is ${daysAgo} days old.</strong>
                    The auto-updater may be down, so sessions shown here could have changed.
                    Tap Refresh up top, and double-check with the venue before travelling.
                </div>`;
            }
        }

        // v3.12: a source that could not be read no longer gets a banner each. The "checked"
        // part of the status line turns to ⚠️ with a count, and its sheet names every source.
    };

    Render.programs = function () {
        const { filtered } = S;
        const chatState = (window.SkateChat && SkateChat.booted) ? SkateChat.getState() : null;   // v3.8: the chat code may not be loaded
        const now = new Date();
        Render.dataWarnings(SkateAPI.getMetadata(), now);
        Render.status();
        Render.pills();
        pruneEndedSaved(now.getTime());
        Render.savedNext();
        Render.installHint();
        $('btn-clear-location').classList.toggle('hidden', !SkateGeo.getUserLocation());

        // list ↔ week (the Week button)
        $('calendar-wrap').classList.toggle('hidden', !S.calMode);
        $('program-list').classList.toggle('hidden', S.calMode);
        $('show-more').classList.toggle('hidden', S.calMode);
        if (S.calMode) return Render.calendar();

        const list = $('program-list');
        if (!filtered.length) {
            const paidOnly = !S.paidVisible && S.paidMatching > 0;
            const empty = S.savedOnly ? 'Nothing saved yet. Tap ♡ on any session to keep it here.'
                : (S.day === 'today' && !S.search && !S.nearRink) ? 'No more sessions today. <button class="flink" data-day-tomorrow="1">See tomorrow</button>'
                : paidOnly ? `All ${S.paidMatching} matching session${S.paidMatching === 1 ? ' is' : 's are'} at paid venues. Switch Free only off in the top bar to show them.`
                : S.rinkScope === 'mine' ? 'Nothing at your rinks with these filters. Tap the My rinks pill to see every rink.'
                : 'No sessions match. Try fewer filters, or tap the city pill to add cities.';
            list.innerHTML = `<li class="loading">${empty}</li>`;
            list.dataset.firstDay = ''; Render.dayBar(null);
            const tmr = list.querySelector('[data-day-tomorrow]');
            if (tmr) tmr.onclick = () => Actions.setDay('tomorrow');
            Render.showMore(0);
            return;
        }

        // the heart nudge rides the first card until a first save or "Got it";
        // anyone who already has saved sessions never sees it
        if (!SkateSettings.get('heartHintDone') && SkateFavorites.count()) SkateSettings.set('heartHintDone', true);
        S.heartHint = false;   // v3.16.5: no tip on the first card any more; it waits until someone has scrolled a while (maybeHeartTip)

        // rows grouped under day headers — the date leaves the row
        const items = filtered.slice(0, S.limit);
        const todayKey = SkateTime.todayKey(), tomorrowKey = SkateTime.addDays(todayKey, 1);
        let html = '', lastDay = null;
        items.forEach((p, i) => {
            const d = P.dateStr(p).slice(0, 10);
            if (d !== lastDay) {
                lastDay = d;
                const dt = d ? parseLocalDate(d).toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' }) : 'Undated';
                const rel = d === todayKey ? 'Today' : d === tomorrowKey ? 'Tomorrow' : '';
                // v3.11: where skates can be borrowed free that day
                const free = d ? lendOn(d) : [];
                const freeLine = free.length
                    ? `<button type="button" class="day-lend" data-lending="1" title="Where to borrow skates free that day">⛸ Free skates: ${escapeHtml(free.slice(0, 2).map(f => f.place + (f.hours ? ' ' + f.hours : '')).join(' · '))}${free.length > 2 ? ` +${free.length - 2}` : ''}</button>` : '';
                // v3.16: the first day's name is on the bar above the list (its free-skates line stays)
                const first = i === 0;
                html += `<li class="day-head${d === todayKey ? ' today' : ''}${first ? ' first' : ''}${first && !freeLine ? ' bare' : ''}" data-day="${escapeHtml(d)}"><span class="dh-text">${rel ? `<strong>${rel}</strong> · ` : ''}${escapeHtml(dt)}</span>${freeLine}</li>`;
            }
            html += Render.programRow(p, i, chatState, now);
        });
        list.innerHTML = html;
        list.dataset.firstDay = items.length ? P.dateStr(items[0]).slice(0, 10) : '';
        spyDay();
        Render.showMore(filtered.length - items.length);
    };

    /**
     * One quiet line in two parts (v3.12): the count (tap → options) and
     * "✓ checked 9:14 PM" (tap → the Data status sheet). The second part turns
     * to ⚠️ when the checks are late or a source in the chosen cities could not
     * be read, with how many.
     */
    Render.status = function () {
        const now = Date.now();
        const meta = SkateAPI.getMetadata();
        const n = S.filtered.length;
        const stamps = [SkateAlerts.checkedAt, SkateAlerts.liveCheckedAt].filter(Boolean).map(x => new Date(x).getTime());
        // toronto.ca itself: its closure notices, its live schedule, its weekly file
        const cityStale = !!((SkateAlerts.checkedAt && now - new Date(SkateAlerts.checkedAt) > ALERTS_STALE_MS) ||
                      (SkateAlerts.liveCheckedAt && now - new Date(SkateAlerts.liveCheckedAt) > LIVE_STALE_MS) ||
                      (meta?.lastUpdated && (now - new Date(meta.lastUpdated)) / 86400000 > 7));
        const behind = sourcesBehind(cityStale);
        // v3.16: when things were checked is in the count's menu now; the count itself warns only when toronto.ca or a city's own site is behind
        S.behind = behind;
        S.checkedAt = stamps.length ? Math.max(...stamps) : (meta?.lastUpdated ? new Date(meta.lastUpdated).getTime() : null);
        const sd = $('status-data');
        sd.textContent = `${behind ? '⚠️ ' : ''}${n} session${n === 1 ? '' : 's'}`;
        if (!S.paidVisible && S.paidMatching) sd.appendChild(el('span', { class: 'sd-paid' }, [` · ${S.paidMatching} paid hidden`]));
        sd.classList.toggle('stale', !!behind);
        sd.title = behind ? `${behind} source${behind === 1 ? '' : 's'} behind. Tap, then Data status.` : 'How many sessions match. Tap for options.';
        Render.dayBar();
        if (!$('status-modal').classList.contains('hidden')) Render.dataStatus();   // the open sheet follows the minute tick
    };

    /* ---------- Data status (v3.12) ----------
     * Every source the app reads, as rows: what it is, how its last read went,
     * when. Grouped (the City, Toronto's board-run arenas, other Toronto rinks,
     * then each other city) and narrowed to the cities in the Where filter.
     * meta.json carries a state per source (see the pipeline): older files
     * only say ok or not, which still reads correctly here.
     */
    const stDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
    const stWhen = (iso) => {
        const d = new Date(iso);
        if (!iso || isNaN(d)) return '';
        const sameDay = stDayKey.format(d) === SkateTime.todayKey();
        const day = sameDay ? '' : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'America/Toronto' }) + ', ';
        return day + SkateSettings.formatTime(d.getTime());
    };
    const stDay = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd || '') ? parseLocalDate(ymd).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(ymd.slice(0, 4) !== SkateTime.todayKey().slice(0, 4) ? { year: 'numeric' } : {}) }) : '');
    const ST_RANK = { failed: 7, changed: 6, new: 5, pending: 4, closed: 3, dormant: 2, none: 1, ok: 0 };
    const plural = (n, word) => `${Number(n).toLocaleString('en-CA')} ${word}${n === 1 ? '' : 's'}`;
    const endDot = (s) => (/[.!?]$/.test(s) ? s : s + '.');   // "…11:00 a.m." already ends in a full stop

    /** How a source's last read went, from a file of any age: its own state, else ok / failed. */
    const stateOf = (s) => (!s || typeof s !== 'object') ? 'new' : (typeof s.state === 'string' && s.state in ST_RANK) ? s.state : (s.ok === false ? 'failed' : 'ok');
    /**
     * For the status line: the sources everyone relies on that are behind, in the chosen cities.
     * v3.15.3: only toronto.ca (`cityStale`: its notices, live check or weekly file are old) and each
     * other city's own site (`main` in CFG.sourceInfo). An arena's or a rink's own page being behind
     * is in the Data status sheet only: its sessions already say "Unverified", and a warning on
     * everyone's line for one rink's page worried people for nothing. One pass, no rows built.
     */
    function sourcesBehind(cityStale = false) {
        const wanted = (city) => !S.cities.length || S.cities.includes(city);
        const fromCity = cityStale && wanted('Toronto') ? 1 : 0;
        const sources = (SkateAPI.getMetadata() || {}).sources;
        if (!sources || typeof sources !== 'object') return fromCity;
        const rows = new Set();
        for (const key of Object.keys(sources)) {
            if (!(CFG.sourceInfo[key] || {}).main) continue;
            const state = stateOf(sources[key]);
            // a page that is only watched (no skating there) changing its wording hides nothing: not "behind".
            // v3.12.3: nor does a page edited after its hours were typed in: the hours still show, and a
            // warning on everyone's schedule for an edit that is usually a photo or a typo alarmed people.
            if (state !== 'failed' && !(state === 'changed' && sources[key].manual)) continue;
            if (!wanted(CFG.sourceInfo[key].city || 'Toronto')) continue;
            rows.add(CFG.sourceRows[key] || key);
        }
        return fromCity + rows.size;
    }

    /** v3.12.1: the day a hand-entered source's page was edited after its hours were typed in ('' when it was not). */
    const editedOn = (s) => (s && typeof s.edited === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.edited)) ? s.edited : '';

    /** One source (or several that are one place) → a row. */
    function sourceRow(keys, sources, fallbackAt, today) {
        const infos = keys.map(k => CFG.sourceInfo[k] || {});
        const info = infos[0];
        const parts = keys.map(k => {
            const s = sources[k];
            const state = stateOf(s);
            if (state === 'new') return { state, count: 0 };
            return { ...s, state, count: Number.isFinite(s.count) ? s.count : 0, at: s.at || fallbackAt };
        });
        const worst = parts.slice().sort((a, b) => ST_RANK[b.state] - ST_RANK[a.state])[0];
        const count = parts.reduce((n, x) => n + x.count, 0);
        const at = parts.map(x => x.at).filter(Boolean).sort().pop() || '';
        const str = (x, max = 220) => (typeof x === 'string' ? x.slice(0, max) : '');
        const quote = str(worst.quote, 170), note = str(worst.note, 320);
        const says = quote ? `Its page says: “${quote}”` : note;
        const lines = [];
        let tone = 'ok', head = '';
        switch (worst.state) {
            case 'failed':
                tone = 'warn';
                head = worst.okAt ? `not read since ${stWhen(worst.okAt)}` : 'could not be read';
                lines.push(count ? `Showing the ${plural(count, 'session')} from the last good read.` : 'Nothing from it is listed until it reads again.');
                if (worst.error) lines.push(`Last try ${stWhen(worst.at)}: ${str(worst.error, 140)}`);
                break;
            case 'changed':
                // hand-entered hours are hidden until they are checked again (sessions missing: a warning);
                // a place with no public skating whose page changed its wording hides nothing (a note)
                tone = worst.manual ? 'warn' : 'wait'; head = 'its page changed';
                lines.push(note || 'Its page no longer says what it did. It needs a look.');
                break;
            case 'new':
                tone = 'wait'; head = 'not read yet';
                lines.push('New in the app. The next data update reads it.');
                break;
            case 'pending': {
                tone = 'wait';
                const from = worst.season && worst.season.from;
                head = from && from > today ? `opens ${stDay(from)}` : 'not open yet';
                if (says) lines.push(says);
                if (count) lines.push(`${plural(count, 'session')} already listed.`);
                break;
            }
            case 'closed':
                tone = 'off'; head = 'closed for the season';
                if (says) lines.push(says);
                break;
            case 'dormant':
                tone = 'off'; head = 'out of season';
                lines.push(worst.resumes ? `Not read again until ${stDay(worst.resumes)}, a few weeks before it usually opens.` : 'Not read until a few weeks before it usually opens.');
                break;
            case 'none':
                tone = 'off'; head = 'no public skating';
                if (quote) lines.push(`Its site says: “${quote}”`);
                break;
            default:
                head = `read ${stWhen(at)}`;
                lines.push(count ? plural(count, 'session') : 'No sessions listed right now.');
                if (note) lines.push(note);
        }
        // v3.12.1: the site's own page list says the page was edited after the hours were typed in
        const edited = worst.state === 'failed' || worst.state === 'changed' ? '' : editedOn(worst);
        if (edited) {     // a note, not a warning (v3.12.3)
            tone = 'wait'; head = 'its page was edited';
            lines.unshift(`Its page was edited on ${stDay(edited)}, after these hours were entered, so they are being checked again. Its own site has the final word.`);
        }
        if (worst.manual && worst.state !== 'changed') lines.push(`Hours entered by hand on ${stDay(str(worst.manual, 10))} (its site does not allow them to be read automatically). Its page is still checked each time.`);
        infos.forEach(i => { if (i.status && !lines.includes(i.status)) lines.push(i.status); });
        if (tone !== 'ok' && tone !== 'warn' && at && worst.state !== 'new' && worst.state !== 'dormant') lines.push(endDot(`Checked ${stWhen(at)}`));
        return { kind: 'source', id: keys.join('+'), city: info.city || 'Toronto', name: info.place || info.label || keys[0], site: info.site || '', tone, head, lines, state: worst.state };
    }

    /** Every row the Data status sheet can show, in order, each tagged with its group and city. */
    function statusRows(nowMs = Date.now(), { all = false } = {}) {
        const meta = SkateAPI.getMetadata() || {};
        const sources = (meta.sources && typeof meta.sources === 'object') ? meta.sources : {};
        const today = SkateTime.todayKey();
        const rows = [];
        const add = (group, groupLabel, row) => rows.push({ ...row, group, groupLabel });

        // -- the City of Toronto: its open data, its closure notices, its live schedule, its lending van
        if (meta.lastUpdated) {
            const old = (nowMs - new Date(meta.lastUpdated)) / 86400000 > 7;
            const cityCount = meta.counts && Number.isFinite(meta.counts.cityPrograms) ? meta.counts.cityPrograms : null;
            const lines = [cityCount != null ? `${plural(cityCount, 'session')} in the City's weekly file.` : ''];
            if (meta.city && meta.city.modified) lines.push(endDot(`The City last refreshed that file ${stWhen(meta.city.modified)}`));
            add('city', 'City of Toronto', { kind: 'city', id: 'city-schedule', city: 'Toronto', name: 'Drop-in schedule', site: 'toronto.ca open data', tone: old ? 'warn' : 'ok', head: `read ${stWhen(meta.lastUpdated)}`, lines: lines.filter(Boolean) });
        }
        if (SkateAlerts.loaded && SkateAlerts.checkedAt) {
            const st = SkateAlerts.stats(nowMs);
            const lines = [`${plural(st.total, 'notice')} on file${st.recent ? `, ${st.recent} posted in the last day` : ''}. Each is shown with the City's own words and the day it was posted.`];
            if (SkateAlerts.reader) lines.push(alertReaderLine(SkateAlerts.reader));
            add('city', 'City of Toronto', { kind: 'city', id: 'city-alerts', city: 'Toronto', name: 'Rink closures and notices', site: 'toronto.ca', tone: nowMs - new Date(SkateAlerts.checkedAt) > ALERTS_STALE_MS ? 'warn' : 'ok', head: `checked ${stWhen(SkateAlerts.checkedAt)}`, lines });
        }
        if (SkateAlerts.loaded && SkateAlerts.liveCheckedAt) {
            const ls = SkateAlerts.liveStats;
            add('city', 'City of Toronto', { kind: 'city', id: 'city-live', city: 'Toronto', name: 'Live schedule cross-check', site: 'toronto.ca', tone: nowMs - new Date(SkateAlerts.liveCheckedAt) > LIVE_STALE_MS ? 'warn' : 'ok', head: `checked ${stWhen(SkateAlerts.liveCheckedAt)}`,
                lines: [ls ? `${plural(ls.missing, 'session')} hidden because toronto.ca no longer lists ${ls.missing === 1 ? 'it' : 'them'}, ${ls.extra} added from it.` : 'Each City session in the next two weeks is checked against the rink\'s own page.'] });
        }
        if (S.lending && S.lending.van && S.lending.checkedAt) {
            const stops = lendIx ? lendIx.stops.filter(x => x.date >= today).length : 0;
            add('city', 'City of Toronto', { kind: 'city', id: 'city-lending', city: 'Toronto', name: 'Free skates van', site: 'toronto.ca', tone: stops ? 'ok' : 'wait', head: `checked ${stWhen(S.lending.checkedAt)}`,
                lines: [stops ? `${plural(stops, 'upcoming stop')} posted.` : 'The City has not posted this winter\'s stops yet.'] });
        }

        // -- everything else: Toronto's two groups in their set order, then one group per city
        const rowKeys = (keys) => {                       // keys → [[k, k, …], …] merged by CFG.sourceRows, order kept
            const seen = new Map();
            keys.forEach(k => { const id = CFG.sourceRows[k] || k; if (!seen.has(id)) seen.set(id, []); seen.get(id).push(k); });
            return [...seen.values()];
        };
        const known = new Set(), placed = new Set();
        Object.keys(CFG.sourceInfo).forEach(k => { if (k !== 'city') known.add(k); });
        Object.keys(sources).forEach(k => known.add(k));
        CFG.sourceGroups.forEach(g => rowKeys(g.keys.filter(k => known.has(k))).forEach(keys => {
            keys.forEach(k => placed.add(k));
            add(g.id, g.label, sourceRow(keys, sources, meta.lastUpdated, today));
        }));
        const rest = rowKeys([...known].filter(k => !placed.has(k))).map(keys => sourceRow(keys, sources, meta.lastUpdated, today));
        rest.sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name));
        rest.forEach(r => add(`city:${r.city}`, r.city, r));

        return (all || !S.cities.length) ? rows : rows.filter(r => S.cities.includes(r.city));
    }

    Render.dataStatus = function () {
        const box = $('status-body');
        const keep = box.scrollTop;
        const rows = statusRows(Date.now(), { all: S.statusAll });
        const mark = { ok: '✓', warn: '⚠', wait: '◌', off: '–' };
        const scoped = S.cities.length && !S.statusAll;
        let html = '<p class="st-lead">Sources are re-read every 30 minutes, and the City\'s closure notices every 10. Each row is one place the schedule comes from.</p>';
        if (S.cities.length) {
            html += scoped
                ? `<p class="st-scope">Showing your cities: <strong>${escapeHtml(S.cities.join(', '))}</strong>. <button type="button" class="flink" data-st-all="1">Show every city</button></p>`
                : `<p class="st-scope">Showing every city. <button type="button" class="flink" data-st-all="0">Only ${escapeHtml(cityPillLabel())}</button></p>`;
        }
        const warn = rows.filter(r => r.tone === 'warn').length;
        if (warn) html += `<p class="st-sum warn">${warn === 1 ? 'One source needs' : `${warn} sources need`} attention. Their sessions may be missing or out of date.</p>`;
        let group = null;
        rows.forEach(r => {
            if (r.group !== group) {
                if (group !== null) html += '</ul>';
                group = r.group;
                html += `<h4>${escapeHtml(r.groupLabel)}</h4><ul class="st-list">`;
            }
            html += `<li class="st-row st-${r.tone}" data-st="${escapeHtml(r.id)}"><span class="st-mark" aria-hidden="true">${mark[r.tone] || '·'}</span><div class="st-main">` +
                `<div class="st-top"><strong>${escapeHtml(r.name)}</strong><span class="st-head">${escapeHtml(r.head)}</span></div>` +
                r.lines.map(l => `<div class="st-line">${escapeHtml(l)}</div>`).join('') +
                (r.site ? `<div class="st-site">${escapeHtml(r.site)}</div>` : '') + '</div></li>';
        });
        if (group !== null) html += '</ul>';
        if (!rows.length) html += '<p class="settings-hint">Nothing to show yet: the schedule is still loading.</p>';
        html += '<div class="st-actions"><button type="button" class="btn-secondary btn-small" data-st-refresh="1">Refresh now</button><button type="button" class="btn-secondary btn-small" data-st-city="1">Ask for a fresh pull from the City</button></div>';
        box.innerHTML = html;
        box.scrollTop = keep;
    };

    Render.showMore = function (left) {
        const wrap = $('show-more');
        wrap.innerHTML = left > 0
            ? `<button class="btn-more" data-more="30">Show ${Math.min(30, left)} more <span class="btn-more-left">· ${left} left</span></button>` +
              (left > 30 ? `<button class="btn-more all" data-more="all">Show all ${left}</button>` : '')
            : '';
    };

    /** Settings → Display → Calendar 2.0 (the day planner), or any planner view picked from the ▾ beside Calendar. */
    const cal2Active = () => SkateSettings.get('cal2') === true;
    /** v3.12: which calendar the Calendar button shows: 'week' (the grid) | 'time' | 'rink' | 'distance' (the planner's three views). */
    const calType = () => (cal2Active() ? S.cal2By : 'week');

    function setCalNav(dayMode) {
        $('btn-cal-prev').textContent = dayMode ? '‹ Day' : '‹ Week';
        $('btn-cal-next').textContent = dayMode ? 'Day ›' : 'Week ›';
        $('btn-cal-prev').title = $('btn-cal-prev').ariaLabel = dayMode ? 'Previous day' : 'Previous week';
        $('btn-cal-next').title = $('btn-cal-next').ariaLabel = dayMode ? 'Next day' : 'Next week';
    }

    Render.calendar = function () {
        if (cal2Active()) return Render.calendar2();
        setCalNav(false);
        const view = $('calendar-view');
        const prevGrid = view.querySelector('.cal-grid');
        const sameWeek = S.calRenderedWeek === S.calWeekOffset;
        const keepScroll = sameWeek && prevGrid ? prevGrid.scrollLeft : null;
        const res = SkateCalendar.render(view, S.filtered, {
            weekOffset: S.calWeekOffset,
            fmtClock,
            idFor: p => P.id(p),
            isSaved: p => SkateFavorites.has(p),
            alertFor: p => SkateAlerts.forProgram(p),
            statusFor: p => SkateTime.status(p),
            typeFor: p => P.typeCls(p)
        });
        // the minute tick re-renders: never yank the reader back to today's column
        if (keepScroll != null) {
            const grid = view.querySelector('.cal-grid');
            if (grid) { grid.scrollLeft = keepScroll; SkateCalendar.syncDayStrip(view); }
        }
        S.calRenderedWeek = S.calWeekOffset;
        $('cal-label').textContent = `${res.label} · ${res.total} session${res.total === 1 ? '' : 's'}`;
        Render.calLegend(res);
    };

    /** Calendar 2.0: the day planner (SkateCalendar2), same popover as the grid. */
    Render.calendar2 = function () {
        const view = $('calendar-view');
        const todayKey = SkateTime.todayKey();
        if (!S.cal2Day) S.cal2Day = todayKey;
        const tor = new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false, hour: '2-digit', minute: '2-digit' });
        const nowMinutes = (+tor.slice(0, 2)) * 60 + (+tor.slice(3, 5));
        const mine = new Set(SkateSettings.get('myRinks') || []);
        const res = SkateCalendar2.render(view, S.filtered, {
            day: S.cal2Day, todayKey, nowMinutes, by: S.cal2By, showEnded: S.cal2ShowEnded,
            hasLocation: !!SkateGeo.getUserLocation(), radius: S.radius, radiusOptions: CFG.radiusOptions, bands: CFG.radiusOptions,
            fmtClock, fmtKm: SkateGeo.fmtKm, fmtMins: SkateTime.fmtMins, fmtPrice, priceLabel, ageText,
            kindLabel: p => { const cls = P.typeCls(p); return (CFG.activityTags.find(t => t.cls === cls) || {}).label || 'Skate'; },
            distanceFor: p => SkateGeo.distanceForProgram(p),
            idFor: p => P.id(p),
            isSaved: p => SkateFavorites.has(p),
            alertFor: p => SkateAlerts.forProgram(p),
            statusFor: p => SkateTime.status(p),
            typeFor: p => P.typeCls(p),
            rinkKey: p => P.locKey(p),
            rinkInfo: (key, p) => ({ mine: mine.has(key), dist: SkateGeo.distanceForProgram(p) })
        });
        S.calRenderedWeek = null;   // the classic grid must not restore a stale scroll when switched back
        setCalNav(true);
        $('cal-label').textContent = `${res.label} · ${res.total} session${res.total === 1 ? '' : 's'}`;
        Render.calLegend(res, 'planner');
    };

    Render.programRow = function (p, idx, chatState, now) {
        const pid = P.id(p);
        const activity = P.activity(p) || 'Unknown';
        const location = P.location(p);
        const time = P.time(p), endTime = P.endTime(p);

        // Live status vs *Toronto* time: Starts in Xm / On now · Xm left / Ended
        const st = SkateTime.status(p, now.getTime());
        let statusChip = '', rowStateCls = '';
        if (st.phase === 'soon') {
            statusChip = `<span class="happening-now">Starts in ${SkateTime.fmtMins(st.minsToStart)}</span>`;
            rowStateCls = ' happening-soon';
        } else if (st.phase === 'live') {
            statusChip = `<span class="happening-now live">On now · ${SkateTime.fmtMins(st.minsLeft)} left</span>`;
            rowStateCls = ' happening-soon is-live';
        } else if (st.phase === 'ended') {
            statusChip = '<span class="ended-chip">Ended</span>';
            rowStateCls = ' is-ended';
        }

        // Service alert for this location (toronto.ca snapshot), or the live-schedule
        // verdict (only rendered when the reader asked to see dropped sessions)
        const alert = SkateAlerts.forProgram(p);
        const off = officialUrl(p);
        const site = officialSite(p);
        const verify = off ? ` <a class="verify-link" href="${escapeHtml(off)}" target="_blank" rel="noopener">Check ${escapeHtml(site)} ↗</a>` : '';
        let alertHtml = '';
        if (alert && alert.live) {
            alertHtml = `<div class="alert-banner closed live-flag"><strong>${escapeHtml(alert.reason)}.</strong> ${escapeHtml(alert.text)}${verify}</div>`;
        } else if (alert && alert.level === 'note') {
            // a grey heads-up, not about this session: an alert that ended in the last few days (v3.9),
            // a building notice, an alert for other hours, last season's closure notice (v3.10)
            // v3.16.4: folded to one line (tap to read): a notice that does not touch this session must not push the next sessions off a phone's screen
            alertHtml = `<details class="alert-banner note fold"><summary><strong>${escapeHtml(alert.lead || 'Heads-up')}</strong></summary><div class="fold-body">${escapeHtml(alert.text)}${verify}</div></details>`;
        } else if (alert) {
            const closed = alert.level === 'closed';
            const lead = alert.lead || (closed ? 'Likely cancelled, rink alert'
                : alert.padOnly ? 'One pad is closed here. This session likely runs on the other pad'
                : 'Service alert at this rink');
            const body = [alert.reason, alert.text].filter(Boolean).map(escapeHtml).join('. ');
            alertHtml = `<div class="alert-banner ${closed ? 'closed' : 'warning'}"><strong>${escapeHtml(lead)}.</strong> ${body}${verify}</div>`;
        }

        // Schedules read from a PDF or website have no live feed: say so, calmly.
        // v3.12: an outdoor rink's own hours are as official as it gets; what they cannot know is tomorrow's weather.
        const outdoorSrc = !!CFG.sourceInfo[p.Source]?.outdoor;
        const unverifiedHtml = p.Unverified ? `<div class="alert-banner unverified"><strong>${outdoorSrc ? 'Outdoor ice' : 'Unverified'}.</strong> ${outdoorSrc ? `Hours read from ${escapeHtml(site)}. It closes in warm, wet or very cold weather. Check before you go` : `Read from ${escapeHtml(site)}, no live feed. Check before you go`}${p.InfoUrl ? `: <a href="${escapeHtml(p.InfoUrl)}" target="_blank" rel="noopener">${escapeHtml(site)} ↗</a>` : '.'}</div>` : '';

        // Price as a price tag; notes (residents-only, age tiers) as a wrapping line
        const srcInfo = CFG.sourceInfo[p.Source];
        const price = p.Paid
            ? `<span class="price-badge paid" title="${escapeHtml(srcInfo?.note || 'Paid venue')}">${escapeHtml(priceLabel(p))}</span>`
            : '<span class="price-badge free">Free</span>';
        // the City lists a session once per pad; merged copies at a multi-pad arena = both pads
        const rinkRec = SkateGeo.rinkByLocation(P.locKey(p));
        const padsBadge = (p.Copies > 1 && rinkRec && rinkRec.pads > 1)
            ? `<span class="pads-badge" title="Listed ${p.Copies} times by the venue: the session runs on ${Math.min(p.Copies, rinkRec.pads)} pads at once">${Math.min(p.Copies, rinkRec.pads)} pads</span>` : '';
        const noteBadge = p.PriceNote ? `<span class="note-badge">${escapeHtml(p.PriceNote)}</span>` : '';
        // v3.7: skate rentals, as the rink's own site states them (the sentence is the tooltip; tap opens the page)
        const facts = factsFor(P.locKey(p));
        const factsBadge = (facts && facts.rentals && facts.rentals.available === 'yes')
            ? `<a class="facts-badge yes" href="${escapeHtml(facts.rentals.url || facts.url || '#')}" target="_blank" rel="noopener" title="${escapeHtml(factsTitle(facts, 'rentals'))}">⛸ Rentals${facts.rentals.price != null ? ` $${fmtPrice(facts.rentals.price)}` : ''}</a>`
            : (facts && facts.rentals && facts.rentals.available === 'no')
                ? `<span class="facts-badge no" title="${escapeHtml(factsTitle(facts, 'rentals'))}">No rentals</span>`
                : '';
        // v3.11: free skates at this rink during this session (the City's lending van, or another confirmed free option)
        const lend = lendFor(p);
        const lendBadge = lend ? `<button type="button" class="facts-badge lend" data-lending="1" title="${escapeHtml(lend.title)}">⛸ ${escapeHtml(lend.text)}</button>` : '';
        // Venues without online booking (PDF/HTML towns) link their schedule page instead.
        const registerLink = (p.Paid && p.RegistrationUrl)
            ? (p.RegistrationUrl === p.InfoUrl
                ? `<a class="row-link strong" href="${escapeHtml(p.RegistrationUrl)}" target="_blank" rel="noopener" title="The venue's own page: its schedule and how to pay">Details ↗</a>`
                : `<a class="row-link strong" href="${escapeHtml(p.RegistrationUrl)}" target="_blank" rel="noopener" title="The venue's registration page">Register ↗</a>`)
            : '';

        // Live spots (fetched from the venue's registration API in-browser).
        // DaySmart semantics (verified 2026-09-14): open_slots -1 = no cap,
        // registration_status ∈ open | upcoming | full | closed | null.
        const live = p.Paid ? SkateLive.forProgram(p) : null;
        let spotsBadge = '';
        if (live && st.phase !== 'ended') {
            // counts read by the home server (PickupHub) carry their snapshot time; DaySmart's are fetched live here
            const src = live.snapshotAt
                ? `From the venue's registration system, as of ${SkateSettings.formatTime(new Date(live.snapshotAt).getTime())}`
                : 'Live from the venue\'s registration system';
            const opens = live.opensAt ? new Date(live.opensAt) : null;
            const opensTxt = opens && !isNaN(opens) ? opens.toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(/\.m\./g, 'm').replace(' a m', ' am').replace(' p m', ' pm') : '';
            if (live.status === 'full') {
                spotsBadge = `<span class="spots-badge full" title="${escapeHtml(src)}. The venue reports this session as full${p.RegistrationUrl ? ', a waitlist may be open on their site' : ''}.">Full</span>`;
            } else if (live.status === 'closed') {
                spotsBadge = `<span class="spots-badge closed-reg" title="${escapeHtml(src)}. Online registration for this session is closed.">Registration closed</span>`;
            } else if (live.status === 'upcoming') {
                spotsBadge = `<span class="spots-badge closed-reg" title="${escapeHtml(src)}. Online registration has not opened yet.">Registration opens ${opensTxt ? escapeHtml(opensTxt) : 'later'}</span>`;
            } else if (live.open != null) {
                spotsBadge = `<span class="spots-badge${live.open <= 20 ? ' low' : ''}" title="${escapeHtml(src)}">${live.open}${live.capacity ? '/' + live.capacity : ''} spots left</span>`;
            } else if (live.unlimited && live.status === 'open') {
                spotsBadge = `<span class="spots-badge" title="${escapeHtml(src)}. No capacity limit set by the venue.">Registration open</span>`;
            }
        }

        const km = SkateGeo.distanceForProgram(p);
        const dist = km != null ? `<span class="dist">${SkateGeo.fmtKm(km)}</span>` : '';
        const note = CFG.locationNotes[String(p['Location ID'] ?? '')];
        const noteBtn = note ? `<button class="loc-note where-note" data-note="${escapeHtml(note)}" title="${escapeHtml(note)}" aria-label="Rink note">📝</button>` : '';

        const isFavorite = SkateFavorites.has(p);
        const actionHtml = CFG.programActions.map(a => {
            let title = a.title || '', text = a.text || '', extraCls = '';
            if (a.act === 'fav') {
                title = isFavorite ? 'Remove from saved' : 'Save this session';
                text = isFavorite ? '♥' : '♡';
                extraCls = isFavorite ? ' active' : (idx === 0 && S.heartHint ? ' nudge' : '');
            }
            return `<button data-act="${a.act}" data-idx="${idx}" class="${a.cls}${extraCls}" title="${title}" aria-label="${title}">${text}</button>`;
        }).join('');

        const city = P.city(p);
        const cityTag = city !== 'Toronto' ? `<span class="city-tag">${escapeHtml(city)}</span>` : '';
        // Rink line: the name is the directions link (📍 … ↗) and the ℹ️ beside
        // it opens the official page, so a card is two lines, not four.
        const aka = akaOf(P.locKey(p)).first;   // v3.12: "College Park (Barbara Ann Scott Ice Trail)"
        const whereHtml = location
            ? `<a class="where-link" href="${mapsUrl(location, city)}" target="_blank" rel="noopener" title="Directions in Google Maps"><svg class="pin" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>${escapeHtml(location)}${aka ? ` <span class="where-aka">(${escapeHtml(aka)})</span>` : ''} ↗</a>`
            : '';
        const infoLink = off
            ? `<a class="where-info" href="${escapeHtml(off)}" target="_blank" rel="noopener" title="Official page on ${escapeHtml(site)}: the schedule the staff go by. Verify there before you go."><span class="where-info-site">${escapeHtml(site)}</span><svg class=\"where-glyph\" viewBox=\"0 0 16 16\" width=\"14\" height=\"14\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"6.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\"/><path d=\"M1.6 8h12.8M8 1.6c2.3 2.1 2.3 10.7 0 12.8M8 1.6c-2.3 2.1-2.3 10.7 0 12.8M2.8 4.6h10.4M2.8 11.4h10.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.1\"/></svg></a>`
            : '';
        // One-time nudge on the first card: people miss that the heart saves.
        const hint = (idx === 0 && S.heartHint)
            ? '<div class="heart-hint" role="note"><span>Try it: tap <b>♡</b> to save a session. Saved sessions come back as a reminder card up top.</span><button class="heart-hint-x" data-hint-x="1">Got it</button></div>'
            : '';

        return `
            <li class="program-item${rowStateCls}${p.Paid ? ' is-paid' : ''}${isFavorite ? ' is-saved' : ''}${alert ? (alert.level === 'closed' ? ' has-alert-closed' : alert.level === 'note' ? ' has-alert-note' : ' has-alert') : ''}" data-pid="${pid}">
                <div class="program-header">
                    <div class="program-main">
                        <div class="program-title">${escapeHtml(activity)}</div>
                        <div class="program-where">${whereHtml}${infoLink}${noteBtn}${cityTag}${dist}</div>
                    </div>
                    <div class="program-meta">
                        <div class="program-time">${fmtClock(time)}${endTime ? '–' + fmtClock(endTime) : ''}</div>
                        ${statusChip}
                    </div>
                </div>
                ${alertHtml}${unverifiedHtml}
                <div class="program-footer">
                    <div class="program-badges">${P.tagFor(p)}${P.ageBadge(p)}${price}${padsBadge}${factsBadge}${lendBadge}${spotsBadge}</div>
                    <div class="program-actions">${actionHtml}</div>
                    <div class="program-links">${registerLink}</div>
                    ${noteBadge ? `<div class="program-note">${noteBadge}</div>` : ''}
                    ${hint}
                </div>
            </li>`;
    };

    Render.chatUI = function (chatState) {
        const totalUnread = (chatState.totalGroupUnread || 0) + (chatState.totalDmUnread || 0);
        $('chats-badge').textContent = totalUnread;
        $('chats-badge').classList.toggle('hidden', !totalUnread);
        Render.conversations(chatState);
        Render.activeChat(chatState);
        Render.discoverRooms(chatState);
    };

    Render.convRow = function (c) {
        const li = el('li', {
            class: 'conv-item' + (c.unread ? ' unread' : '') + (c.muted ? ' is-muted' : ''),
            dataset: { kind: c.kind, id: c.id }
        });
        const icon = el('span', { class: 'conv-icon' });
        if (c.kind === 'dm') icon.innerHTML = hueDot(c.id);
        else icon.textContent = c.emoji || '👥';

        const info = el('div', { class: 'conv-info' }, [
            el('strong', {}, [c.name + (c.muted ? ' (muted)' : '')]),
            el('span', { class: 'conv-preview' }, [c.preview || ''])
        ]);

        const meta = el('div', { class: 'conv-meta' }, [
            el('span', { class: 'conv-time' }, [c.lastTs ? SkateSettings.formatWhen(c.lastTs) : ''])
        ]);
        if (c.unread) meta.appendChild(el('span', { class: 'dm-unread-badge' + (c.mentions ? ' mention' : ''), title: c.mentions ? `${c.mentions} mention${c.mentions === 1 ? '' : 's'} of you` : '' }, [c.mentions ? `@ ${c.unread}` : String(c.unread)]));
        else if (c.kind === 'group' && c.online > 1) {
            meta.appendChild(el('span', { class: 'conv-online', html: `<span class="online-dot"></span>${c.online}` }));
        }
        li.append(icon, info, meta);
        return li;
    };

    Render.conversations = function (chatState) {
        const all = SkateChat.getConversations();
        const f = S.chatFilter;
        const shown = all.filter(c => {
            if (f === 'groups') return c.kind === 'group';
            if (f === 'dms') return c.kind === 'dm' && !c.muted;
            if (f === 'muted') return c.muted;
            return !c.muted; // 'all' keeps muted threads tucked away
        });

        const list = $('conversation-list');
        list.innerHTML = '';
        if (!shown.length) {
            const li = el('li', { class: 'conv-empty' });
            if (f === 'muted') li.textContent = 'Nothing muted.';
            else if (f === 'dms') li.textContent = 'No DMs yet. Tap someone\'s name in any chat to message them.';
            else {
                li.append(
                    el('p', {}, ['No conversations yet.']),
                    el('button', { class: 'btn-primary btn-small', onclick: () => Modal.open('discover-modal') }, ['Browse rooms'])
                );
            }
            list.appendChild(li);
        } else {
            shown.forEach(c => list.appendChild(Render.convRow(c)));
        }

        const sum = kind => all.filter(c => c.kind === kind).reduce((s, c) => s + c.unread, 0);
        const gUnread = sum('group'), dUnread = sum('dm');
        $('cf-groups-badge').textContent = gUnread; $('cf-groups-badge').classList.toggle('hidden', !gUnread);
        $('cf-dms-badge').textContent = dUnread; $('cf-dms-badge').classList.toggle('hidden', !dUnread);
        const mutedThreads = all.filter(c => c.muted).length;
        $('cf-muted').classList.toggle('hidden', !mutedThreads && f !== 'muted');
        $('cf-muted').textContent = `Muted${mutedThreads ? ` (${mutedThreads})` : ''}`;

        $('chats-list-mode').classList.toggle('hidden', S.chatOpen);
        $('chats-convo-mode').classList.toggle('hidden', !S.chatOpen);
    };

    Render.replyRef = function (r) {
        if (!r) return '';
        const mid = r.id && /^[0-9a-f_]{1,64}$/i.test(r.id) ? ` data-ref="${r.id}"` : '';
        return `<div class="reply-ref"${mid}>↩ <strong>${escapeHtml(r.from || '')}</strong> ${escapeHtml(r.text || '')}</div>`;
    };

    /** @name tokens: yours glows, everyone else's is tinted (text is already escaped). */
    function highlightMentions(html, myName) {
        const mine = (myName || '').toLowerCase();
        return html.replace(/@([\w.-]{2,24})/g, (tok, n) => n.toLowerCase() === mine ? `<mark class="mention me">${tok}</mark>` : `<span class="mention">${tok}</span>`);
    }

    Render.msg = function (m, isDm, opts = {}) {
        let cls = 'chat-msg';
        if (m.mine) cls += ' mine';
        if (m.system) cls += ' system';
        if (m.type === 'share') cls += ' share';
        if (m.type === 'guide') cls += ' share guide-share';
        if (opts.cont) cls += ' cont';
        if (m.mention) cls += ' mentions-me';
        if (m.deleted) {
            return `<div class="${cls} deleted" data-mid="${escapeHtml(m.id)}"><div class="bubble">Message unsent</div></div>`;
        }

        let content = highlightMentions(escapeHtml(m.text || ''), opts.myName);
        if (m.type === 'share' && m.data) {
            const loc = m.data.location;
            const town = String(m.data.city || 'Toronto').slice(0, 40);   // rode the wire — clamp it
            const locLink = loc ? `<a href="${mapsUrl(loc, town)}" target="_blank" rel="noopener" title="Directions in Google Maps">${escapeHtml(loc)} ↗</a>` : '';
            content = `<strong>${escapeHtml(m.data.activity)}</strong><br>${locLink}<br>${escapeHtml(m.data.date || '')}${m.data.time ? ' · ' + fmtClock(m.data.time) : ''}${m.data.endTime ? '–' + fmtClock(m.data.endTime) : ''}`;
            // Paid heads-up on shared cards (price sanitized — it rode the wire)
            if (m.data.paid) {
                const p = Number(m.data.price);
                const priceTxt = Number.isFinite(p) && p > 0 && p < 1000 ? `$${p % 1 ? p.toFixed(2) : p}` : 'fee applies';
                content += `<br><span class="share-paid-badge" title="This venue charges. Check their site for exact rates by age.">Paid session · ${priceTxt}</span>`;
            }
            if (m.data.note) content += `<br><span class="share-note">${escapeHtml(String(m.data.note).slice(0, 120))}</span>`;
            const offUrl = httpOnly(m.data.official);
            if (offUrl) content += `<br><a class="share-official" href="${escapeHtml(offUrl)}" target="_blank" rel="noopener">Verify on ${escapeHtml(String(m.data.site || 'official site').slice(0, 30))} ↗</a>`;
            if (m.data.programId) content += `<br><span class="share-open" data-open-program="${escapeHtml(m.data.programId)}">Open in Programs →</span>`;
        } else if (m.type === 'image' && m.data && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(m.data.src || '')) {
            content = `<img class="msg-img" src="${m.data.src}" alt="photo" loading="lazy">`;
        } else if (m.type === 'guide' && m.data) {
            const cat = CFG.guideCategories[m.data.category];
            content = `<strong>${escapeHtml(m.data.title)}</strong>` +
                (cat ? `<br><span class="guide-cat">${cat.emoji} ${escapeHtml(cat.name)}</span>` : '') +
                (m.data.excerpt ? `<br><em>“${escapeHtml(m.data.excerpt)}”</em>` : '') +
                `<br><span class="share-open" data-open-guide="${escapeHtml(m.data.guideId || '')}">Read the guide →</span>`;
        }

        const tick = !m.mine ? '' :
            m.status === 'pending' ? '<span class="msg-tick pending" title="Sending…">⏳</span>' :
            m.status === 'failed' ? '<span class="msg-tick failed" title="Not delivered. Tap the message to retry.">⚠ retry</span>' :
            '<span class="msg-tick" title="Delivered to relays">✓</span>';

        const sender = (!m.mine && !m.system && !opts.cont)
            ? `<div class="sender" ${m.fromPubkey ? `data-pk="${m.fromPubkey}"` : ''} data-name="${escapeHtml(m.from || 'Skater')}" title="Tap for message / mute">${!isDm ? hueDot(m.fromPubkey) : ''}${escapeHtml(m.from || 'Skater')}</div>`
            : '';
        // v3.8: reaction chips under the bubble; yours are outlined, tap to toggle
        const reacts = Object.entries(m.reacts || {}).filter(([, pks]) => pks && pks.length);
        const reactsHtml = reacts.length
            ? `<div class="reacts">${reacts.map(([emoji, pks]) => {
                const mine = opts.me && pks.includes(opts.me);
                return `<button class="react-chip${mine ? ' mine' : ''}" type="button" data-react="${escapeHtml(emoji)}" title="${pks.length} reaction${pks.length === 1 ? '' : 's'}${mine ? ', including yours (tap to take it back)' : ' (tap to add yours)'}">${emoji} ${pks.length}</button>`;
            }).join('')}</div>`
            : '';

        return `
            <div class="${cls}" data-mid="${escapeHtml(m.id)}"${m.localId ? ` data-local="${m.localId}"` : ''}>
                ${sender}
                <div class="bubble">${Render.replyRef(m.replyTo)}${content}${m.system ? '' : `<span class="msg-time">${SkateSettings.formatWhen(m.ts)}${tick}</span>`}</div>
                ${reactsHtml}
            </div>`;
    };

    /** Today / Yesterday / Tue, Oct 7 (with the year once it differs). */
    function dayLabel(ts) {
        const d = new Date(ts), today = new Date(), yest = new Date();
        yest.setDate(today.getDate() - 1);
        if (d.toDateString() === today.toDateString()) return 'Today';
        if (d.toDateString() === yest.toDateString()) return 'Yesterday';
        return d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
    }

    /**
     * A thread as HTML: a "Load earlier" button, a separator per day, and
     * consecutive messages from one person within five minutes grouped
     * under one name.
     */
    function renderThread(visible, isDm, conv, chatState) {
        const parts = [];
        if (visible.length && conv && !conv.historyDone) {
            parts.push(`<div class="load-earlier-wrap"><button class="load-earlier" type="button" data-load-earlier${conv.loadingOlder ? ' disabled' : ''}>${conv.loadingOlder ? 'Loading…' : CFG.actions.loadEarlier.label}</button></div>`);
        }
        let prevDay = null, prevKey = null, prevTs = 0;
        visible.forEach(m => {
            const day = new Date(m.ts).toDateString();
            if (day !== prevDay) { parts.push(`<div class="chat-day"><span>${escapeHtml(dayLabel(m.ts))}</span></div>`); prevDay = day; prevKey = null; }
            const key = m.system ? null : (m.mine ? 'me' : (m.fromPubkey || m.from || 'them'));
            const cont = !!key && key === prevKey && (m.ts - prevTs) < 5 * 60000;
            parts.push(Render.msg(m, isDm, { cont, me: chatState.myPublicKey, myName: chatState.myName }));
            prevKey = key; prevTs = m.ts;
        });
        return parts.join('');
    }

    Render.activeChat = function (chatState) {
        if (!S.chatOpen) return;
        const { activeGroup, viewMode, activeDmThread, activeDmRecipient } = chatState;
        const msgs = $('chat-messages');
        const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;

        let convKey = null, visible = [];

        const hint = $('chat-privacy-hint');
        const cloud = SkateSettings.get('remoteModeration') !== false;
        if (viewMode === 'dm' && activeDmThread) {
            hint.textContent = 'Private message. End-to-end encrypted, never sent to any third party (on-device word filter only).';
            hint.className = 'chat-privacy-hint private';
        } else if (activeGroup && !activeGroup.isPublic) {
            hint.textContent = 'Private group. Never sent to any third party (on-device word filter only).';
            hint.className = 'chat-privacy-hint private';
        } else if (activeGroup) {
            hint.textContent = cloud
                ? 'Public room. Messages are checked by a third-party profanity filter before sending (switch it off in Settings).'
                : 'Public room. On-device word filter only (the cloud check is off in Settings).';
            hint.className = 'chat-privacy-hint public';
        } else {
            hint.className = 'chat-privacy-hint hidden';
        }
        if (viewMode === 'dm' && activeDmThread) {
            convKey = 'dm:' + activeDmRecipient;
            $('chat-title').innerHTML = `${hueDot(activeDmRecipient)}${escapeHtml(activeDmThread.name)} <span class="pk-tag" title="Identity tag: the same tag is the same person, whatever they rename themselves">${shortPk(activeDmRecipient)}</span>`;
            $('chat-status-dot').className = 'status-dot online';
            $('chat-status-text').textContent = SkateChat.Mutes.has(activeDmRecipient) ? 'Muted. You will not be pinged.' : 'Private message';
            $('chat-online').classList.add('hidden');
            $('members-bar').classList.add('hidden');
            visible = activeDmThread.messages || [];
            msgs.innerHTML = visible.length
                ? renderThread(visible, true, activeDmThread, chatState)
                : '<div class="chat-empty"><p>Start a private conversation. It reaches them even if they are offline now.</p></div>';
            $('chat-input').placeholder = `Message ${activeDmThread.name}…`;
        } else if (activeGroup) {
            convKey = 'g:' + activeGroup.id;
            $('chat-title').textContent = `${activeGroup.emoji || (activeGroup.hasPassword ? '🔐' : activeGroup.isPublic ? '🌐' : '🔒')} ${activeGroup.name || 'Skating Group'}`;
            const status = SkateChat.getConnectionStatus();
            $('chat-status-dot').className = `status-dot ${status === 'connected' ? 'online' : 'offline'}`;
            $('chat-status-text').textContent = `#${activeGroup.id.slice(0, 6).toUpperCase()} • ${status}`;
            const online = chatState.onlineCounts?.[activeGroup.id] || 0;
            $('chat-online').classList.toggle('hidden', online < 2);
            $('chat-online').innerHTML = `<span class="online-dot"></span>${online} here now`;

            visible = (activeGroup.messages || []).filter(m => m.mine || !SkateChat.Mutes.has(m.fromPubkey));
            msgs.innerHTML = visible.length
                ? renderThread(visible, false, activeGroup, chatState)
                : '<div class="chat-empty"><p>No messages yet. Say hi.</p></div>';

            Render.members(activeGroup.id);
            $('chat-input').placeholder = 'Type a message…';
        } else {
            // conversation vanished (left the group elsewhere) — back to list
            S.chatOpen = false;
            Render.conversations(chatState);
            return;
        }

        // scroll position + jump-to-latest pill
        S.lastVisibleCount = visible.length;
        if (convKey !== S.lastRenderedConv) {
            S.lastRenderedConv = convKey;
            membersExpanded = false;   // fresh conversation → collapsed member bar
            S.jumpBase = visible.length;
            msgs.scrollTop = msgs.scrollHeight;
            $('jump-pill').classList.add('hidden');
        } else if (nearBottom) {
            msgs.scrollTop = msgs.scrollHeight;
            S.jumpBase = visible.length;
            $('jump-pill').classList.add('hidden');
        } else {
            const fresh = visible.length - S.jumpBase;
            if (fresh > 0) {
                $('jump-pill').textContent = `↓ ${fresh} new message${fresh > 1 ? 's' : ''}`;
                $('jump-pill').classList.remove('hidden');
            }
        }
    };

    // Busy rooms were flooding the bar (and phones) with chips — show a
    // couple, tuck the rest behind "+N more". Collapses again per convo.
    let membersExpanded = false;
    const MEMBERS_CAP = 2;

    Render.members = function (groupId) {
        const roster = SkateChat.getRoster(groupId);
        $('members-bar').classList.remove('hidden');
        const ml = $('members-list');
        ml.classList.toggle('expanded', membersExpanded);
        ml.innerHTML = '';
        if (!roster.length) {
            ml.appendChild(el('span', { class: 'members-solo' }, ['Just you so far. Messages wait here for whoever joins.']));
            return;
        }
        const shown = membersExpanded ? roster : roster.slice(0, MEMBERS_CAP);
        shown.forEach(r => {
            const chip = el('button', {
                class: 'member-chip' + (r.muted ? ' is-muted' : ''),
                dataset: { pk: r.pubkey, name: r.name },
                title: `${r.name}: message or mute`
            });
            chip.innerHTML = `${hueDot(r.pubkey)}${r.online ? '<span class="online-dot"></span>' : ''}${escapeHtml(r.name)}${r.muted ? ' 🔇' : ''}`;
            ml.appendChild(chip);
        });
        if (roster.length > MEMBERS_CAP) {
            const more = el('button', {
                class: 'members-more-btn',
                title: membersExpanded ? 'Collapse the member list' : 'Show every member'
            }, [membersExpanded ? 'Show less' : `+${roster.length - MEMBERS_CAP} more`]);
            more.onclick = (e) => {
                e.stopPropagation();
                membersExpanded = !membersExpanded;
                Render.members(groupId);
            };
            ml.appendChild(more);
        }
    };

    Render.discoverRooms = function (chatState) {
        const rooms = SkateChat.getPublicRooms();
        const joinedIds = Object.keys(chatState.publicRooms || {});
        const wrap = $('discover-rooms');
        wrap.innerHTML = '';
        Object.entries(rooms).forEach(([key, room]) => {
            const secret = chatState.publicRoomSecrets?.[key];
            const roomId = secret ? SkateChat.Crypto.deriveGroupId(secret) : null;
            const isJoined = roomId && joinedIds.includes(roomId);
            const online = roomId ? (chatState.onlineCounts?.[roomId] || 0) : 0;

            const card = el('div', { class: 'room-card' + (isJoined ? ' joined' : ''), dataset: { room: key } });
            card.innerHTML = `
                <span class="room-emoji">${room.emoji}</span>
                <div class="room-info">
                    <div class="room-name">${escapeHtml(room.name)}</div>
                    <div class="room-desc">${escapeHtml(room.desc)}</div>
                    ${isJoined ? `<div class="room-members">✓ Joined${online ? ` • <span class="online-dot"></span>${online} online` : ''}</div>` : ''}
                </div>
                <span class="room-cta">${isJoined ? 'Open →' : 'Join →'}</span>`;
            if (isJoined && roomId) {
                card.appendChild(el('button', {
                    class: 'btn-icon room-leave', title: `Leave ${room.name}`,
                    dataset: { leave: roomId, roomName: room.name }
                }, ['✕']));
            }
            wrap.appendChild(card);
        });
    };

    Render.sharePicker = function (ctx) {
        $('share-title').textContent = ctx.type === 'guide' ? 'Share the guide to…' : 'Share the session to…';
        const list = $('share-dest-list');
        list.innerHTML = '';
        const convs = SkateChat.getConversations().filter(c => !(c.kind === 'dm' && c.muted));
        $('share-empty').classList.toggle('hidden', !!convs.length);
        convs.forEach(c => {
            const li = el('li', { class: 'conv-item share-dest', dataset: { kind: c.kind, id: c.id, name: c.name } });
            const icon = el('span', { class: 'conv-icon' });
            if (c.kind === 'dm') icon.innerHTML = hueDot(c.id); else icon.textContent = c.emoji || '👥';
            li.append(icon, el('div', { class: 'conv-info' }, [el('strong', {}, [c.name])]));
            list.appendChild(li);
        });
    };

    Render.settings = function () {
        const fmt = SkateSettings.get('timeFormat');
        const theme = themeSetting();   // resolved: unchosen 'system' shows as Light
        $$('#settings-timefmt button').forEach(b => b.classList.toggle('active', b.dataset.fmt === fmt));
        $$('#settings-theme button').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
        $$('#settings-sections button').forEach(b => b.classList.toggle('active', SkateSettings.get(b.dataset.vis) !== false));
        // privacy toggles: 'active' means the setting equals its `on` value
        $$('#settings-privacy button').forEach(b => {
            const def = CFG.privacyToggles.find(t => t.id === b.dataset.priv);
            const val = SkateSettings.get(def.id);
            const effective = val == null ? !!def.default : val;
            b.classList.toggle('active', effective === def.on);
        });
    };

    /* ---------- Weather chip (Open-Meteo) ---------- */
    Render.weather = function () {
        const chip = $('weather-chip');
        const w = SkateWeather.current;
        if (!w) { chip.classList.add('hidden'); return; }
        chip.classList.remove('hidden');
        const label = /^my location$/i.test(w.label || '') ? 'near you' : (w.label || '');
        chip.textContent = `${w.emoji} ${w.temp}°`;
        chip.appendChild(el('span', { class: 'wx-spot' }, [` · ${label.length > 18 ? label.slice(0, 17) + '…' : label}`]));
        chip.title = `${w.text} in ${w.label}: ${w.temp}°C, feels like ${w.feels}°C. Tap to pick another spot (Open-Meteo).`;
    };

    /* ---------- Rinks and map: one view for the map, distances and your rinks ---------- */
    /** Municipality of a rinks.json entry: Toronto for City rinks, else the feed's city or district. */
    function rinkCity(r) {
        return r.source === 'city' ? 'Toronto' : (CFG.sourceInfo[r.externalSource]?.city || r.district || 'Toronto');
    }
    /** The Where cities apply to the rink list and the map too (your rinks always show). */
    function rinkInScope(r) {
        if (S.rinksCity === 'all') return true;
        if (S.rinksCity) return rinkCity(r) === S.rinksCity;
        if (!S.cities.length || S.rinksAllCities) return true;
        return S.cities.includes(rinkCity(r)) || (SkateSettings.get('myRinks') || []).includes(String(r.locationid));
    }

    /** Lower case, no accents or punctuation: "Étienne-Brûlé" is found by "etienne brule". */
    const foldText = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const rinkHay = new WeakMap();   // rink → its searchable text, built once
    /** The rink search: every word typed must appear in the name, area, city, address or postal code. */
    function rinkMatchesQuery(r, q) {
        if (!q) return true;
        let hay = rinkHay.get(r);
        if (!hay) rinkHay.set(r, hay = `${foldText(`${r.name} ${Array.isArray(r.aka) ? r.aka.join(' ') : ''} ${r.district || ''} ${rinkCity(r)} ${r.address || ''} ${r.postal || ''}`)} ${foldText(r.postal).replace(/ /g, '')}`);
        return q.split(' ').every(word => hay.includes(word));
    }
    const rinksQuery = () => foldText($('rinks-search').value);
    /** What the map and the list both show: in scope for the chosen cities and matching the search. */
    const rinkShown = (r) => rinkInScope(r) && rinkMatchesQuery(r, rinksQuery());

    /**
     * v3.12.1: how well a rink answers the search, lower first. A rink whose NAME holds the
     * words comes before one that is merely in that area: typing "scarborough" used to open
     * on Agincourt Recreation Centre (A to Z inside the district) with Scarborough Arena
     * Gardens further down. Assumes rinkMatchesQuery(r, q) is already true.
     */
    function rinkRank(r, q) {
        if (!q) return 0;
        const words = q.split(' ');
        const name = foldText(r.name);
        if (name === q) return 0;
        if (name.startsWith(q)) return 1;
        if (words.every(w => name.includes(w))) return name.split(' ').some(part => part.startsWith(words[0])) ? 2 : 3;
        const aka = Array.isArray(r.aka) ? foldText(r.aka.join(' ')) : '';
        if (aka && words.every(w => aka.includes(w))) return 4;                    // its other name
        const area = foldText(`${r.district || ''} ${rinkCity(r)}`);
        if (words.every(w => area.includes(w))) return 5;                          // in that district or city
        return 6;                                                                  // its street, its postal code, or words spread over several of these
    }

    /* v3.12.1: rows are built once and kept. A keystroke in the search only decides which rows
       show and in what order, then moves the existing nodes; a row is rebuilt only when what
       it says has changed (its signature). Before, every letter rebuilt up to 80 rows. */
    const rinkRowCache = new Map();    // rink key → { sig, node }
    let rinkRowsFor = null;            // the rink list the cache belongs to
    let rinkScopeSig = '', rinkListQuery = null;
    let rinkListSig = null;            // what the list shows now, in order: unchanged → the DOM is not touched
    let rinkRowBuilds = 0;             // rows (re)built so far: a rebuilt row means the DOM must take it
    function rinkRowNode(r, mine) {
        const key = String(r.locationid);
        const sp = upcomingSplit(key);
        const sessions = S.paidVisible ? sp.free + sp.paid : sp.free;
        const alerts = SkateAlerts.forLocation(key);
        const starred = mine.has(key);
        const season = seasonWord(r);                              // v3.12: a seasonal rink that is not open right now
        const also = Array.isArray(r.aka) && typeof r.aka[0] === 'string' ? r.aka[0] : '';
        const meta = [
            r.km != null ? SkateGeo.fmtKm(r.km) : null,
            r.address || null,
            (r.kinds || []).map(k => k === 'indoor' ? 'indoor' : 'outdoor').join(' + ') || null,
            r.paid ? 'paid' : null,
            lendNextAt(key),                                      // v3.11: the lending van's next visit here
            ...(factsFor(key) ? factsBits(factsFor(key)) : [])   // v3.7: rentals / admission / helmets from the rink's site
        ].filter(Boolean).join(' · ');
        const label = sessions ? `${sessions} session${sessions === 1 ? '' : 's'}` : (sp.paid ? `${sp.paid} paid` : 'No sessions');
        const seasonTitle = season ? ((r.seasonal && typeof r.seasonal.quote === 'string' && r.seasonal.quote) ? `Its page says: “${r.seasonal.quote.slice(0, 170)}”` : season) : '';
        const akaTitle = also ? (r.aka.length > 1 ? `Also known as ${r.aka.join(', ')}` : `Also known as ${also}`) : '';
        const alertTitle = alerts.length ? 'Service alert: ' + alerts.map(a => a.Reason).join(', ') : '';
        const dead = !sessions && !sp.paid;
        const sig = [r.name, also, akaTitle, season, seasonTitle, meta, label, dead ? 1 : 0, starred ? 1 : 0, alertTitle].join('\u0001');
        const hit = rinkRowCache.get(key);
        if (hit && hit.sig === sig) return hit.node;

        // The whole row shows the rink on the map (the delegate lets the
        // sessions and star buttons win first); Enter/Space does the same.
        const node = el('div', { class: 'rink-row' + (starred ? ' starred' : '') + (alerts.length ? ' has-alert' : ''), dataset: { mapFocus: key }, role: 'button', tabindex: '0', title: 'Show on the map' });
        node.onkeydown = (e) => {
            if (e.target !== node || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            SkateMap.focusRink(key);
            node.classList.add('focused'); setTimeout(() => node.classList.remove('focused'), 1600);
        };
        node.appendChild(el('div', { class: 'rink-info' }, [
            el('strong', {}, [r.name,
                ...(also ? [el('span', { class: 'rink-aka', title: akaTitle }, [` (${also})`])] : []),
                ...(season ? [el('span', { class: 'rink-season', title: seasonTitle }, [season])] : []),
                ...(alerts.length ? [el('span', { class: 'rink-alert', title: alertTitle }, ['alert'])] : [])]),
            el('span', { class: 'rink-meta' }, [meta])
        ]));
        const sessionsBtn = el('button', {
            class: 'btn-small rink-sessions', dataset: { locFilter: key, locName: r.name },
            title: dead ? 'No drop-in sessions listed for this rink' : 'Show only this rink\'s sessions'
        }, [label]);
        if (dead) sessionsBtn.disabled = true;
        node.appendChild(el('div', { class: 'rink-actions' }, [
            sessionsBtn,
            el('button', { class: 'btn-small star' + (starred ? ' starred' : ''), dataset: { locStar: key }, title: starred ? 'Remove from my rinks' : 'Add to my rinks', 'aria-label': starred ? 'Remove from my rinks' : 'Add to my rinks' }, [starred ? '★' : '☆'])
        ]));
        rinkRowCache.set(key, { sig, node });
        rinkRowBuilds++;
        return node;
    }
    /**
     * Build, a few milliseconds at a time, the rows the list has not had to show yet, so that
     * the first letter typed (which can bring in a hundred rinks from further down) finds
     * them ready. Stops when the sheet closes or the data changes.
     */
    let rinkWarmTimer = 0;
    function warmRinkRows() {
        clearTimeout(rinkWarmTimer);
        const rinks = SkateGeo.rinks;
        let i = 0;
        const step = () => {
            if ($('rinks-modal').classList.contains('hidden') || rinks !== SkateGeo.rinks) return;
            const user = SkateGeo.getUserLocation(), mine = new Set(SkateSettings.get('myRinks') || []);
            const t0 = performance.now();
            while (i < rinks.length && performance.now() - t0 < 6) {
                const r = rinks[i++];
                if (rinkRowCache.has(String(r.locationid))) continue;
                rinkRowNode({ ...r, km: user && r.lat != null ? SkateGeo.distanceKm(user, { lat: r.lat, lng: r.lng }) : null }, mine);
            }
            if (i < rinks.length) rinkWarmTimer = setTimeout(step, 80);
        };
        rinkWarmTimer = setTimeout(step, 500);
    }

    Render.rinks = function () {
        const user = SkateGeo.getUserLocation();
        const ask = !user && S.rinksAsk;      // v3.12.2: what a filter needs a spot for, said here and not in a toast over the box
        $('locator-status').textContent = user ? `Distances from ${user.label}` : (ask || 'Type a rink, an area or your postal code. Near me sorts by distance.');
        $('locator-status').classList.toggle('ask', !!ask);
        const wrap = $('rinks-list');
        const scope = $('rinks-scope');
        if (!SkateGeo.loaded || !SkateGeo.rinks.length) {
            wrap.innerHTML = '';
            scope.innerHTML = '';
            rinkScopeSig = ''; rinkListSig = null;
            wrap.appendChild(el('p', { class: 'settings-hint' }, ['Rink list still loading, one second.']));
            return;
        }
        if (rinkRowsFor !== SkateGeo.rinks) { rinkRowsFor = SkateGeo.rinks; rinkRowCache.clear(); }   // new data: nothing kept
        const q = rinksQuery();
        const mine = new Set(SkateSettings.get('myRinks') || []);
        const kind = SkateMap.filter;   // All / Indoor / Outdoor from the sheet's header
        const rows = SkateGeo.rinks
            .filter(r => rinkInScope(r) && rinkMatchesQuery(r, q))
            .filter(r => kind === 'all' || (r.kinds || []).includes(kind))
            .map(r => ({ ...r, city: rinkCity(r), km: user && r.lat != null ? SkateGeo.distanceKm(user, { lat: r.lat, lng: r.lng }) : null, rank: rinkRank(r, q) }));
        rows.sort(q
            ? (a, b) => (a.rank - b.rank) ||                                           // searching: the best match first,
                ((a.km ?? Infinity) - (b.km ?? Infinity)) || a.name.localeCompare(b.name)   // then nearest, then A–Z
            : (a, b) =>
                (mine.has(String(b.locationid)) - mine.has(String(a.locationid))) ||   // browsing: yours first
                ((a.km ?? Infinity) - (b.km ?? Infinity)) ||                            // then nearest
                a.name.localeCompare(b.name));                                          // then A–Z

        // Scope line: which cities the list follows, with a one-tap way out.
        // v3.9: a city picker (the old "show every city" link could not pick one city), and the
        // count here is the same count as the map's title: both follow the city and the kind.
        // (Rebuilt only when what it says changes: a <select> recreated on every letter is wasted work.)
        const selValue = S.rinksCity || (S.cities.length === 1 ? S.cities[0] : (S.cities.length > 1 ? '' : 'all'));
        const scopeSig = [rows.length, kind, S.cities.join('|'), selValue, SkateGeo.rinks.length].join('\u0001');
        if (scopeSig !== rinkScopeSig || !scope.firstChild) {
            rinkScopeSig = scopeSig;
            scope.innerHTML = '';
            scope.appendChild(el('span', {}, [`${rows.length} rink${rows.length === 1 ? '' : 's'}${kind !== 'all' ? ` (${kind})` : ''}`]));
            const counts = {};
            SkateGeo.rinks.forEach(r => { const c = rinkCity(r); counts[c] = (counts[c] || 0) + 1; });
            const sel = el('select', { id: 'rinks-city', class: 'rinks-city', 'aria-label': 'Which city' });
            if (S.cities.length > 1) sel.appendChild(el('option', { value: '' }, [`Your cities (${S.cities.length})`]));
            sel.appendChild(el('option', { value: 'all' }, [`Every city (${SkateGeo.rinks.length})`]));
            Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => sel.appendChild(el('option', { value: c }, [`${c} (${n})`])));
            sel.value = selValue;
            sel.onchange = () => {
                S.rinksCity = sel.value || null;
                S.rinksAllCities = sel.value === 'all';
                SkateMap.setFilter(SkateMap.filter);   // re-pins + retitles; the hook re-renders this list
            };
            scope.appendChild(sel);
        }

        // What the list shows, in order: rows (kept nodes) and two small headings.
        const built = rinkRowBuilds;
        const parts = [];
        const yours = q ? [] : rows.filter(r => mine.has(String(r.locationid)));   // a search is one list, best match first
        const others = q ? rows : rows.filter(r => !mine.has(String(r.locationid)));
        if (yours.length) {
            parts.push({ head: `Your rinks (${yours.length})` });
            yours.forEach(r => parts.push({ key: String(r.locationid), node: rinkRowNode(r, mine) }));
            if (others.length) parts.push({ head: 'Other rinks' });
        }
        others.slice(0, RINK_ROWS_MAX).forEach(r => parts.push({ key: String(r.locationid), node: rinkRowNode(r, mine) }));
        if (others.length > RINK_ROWS_MAX) parts.push({ hint: `${q ? 'The best' : 'The first'} ${RINK_ROWS_MAX} of ${others.length}. ${q ? 'Keep typing' : 'Type a name or an area'} to narrow it down.` });
        if (!rows.length) parts.push({ hint: q ? 'No rink matches that. If it is an address or a postal code, use the line above to measure distances from it.' : 'No rink matches that.' });
        // Another letter of a word that still matches the same rinks in the same order changes
        // nothing on screen: then nothing is moved, and the browser has no layout to redo.
        const listSig = parts.map(x => x.key || x.head || x.hint).join('\u0001');
        if (listSig !== rinkListSig || built !== rinkRowBuilds || !wrap.firstChild) {
            rinkListSig = listSig;
            fillRinkList(wrap, parts);
        }
        if (q !== rinkListQuery) { rinkListQuery = q; wrap.scrollTop = 0; }   // a new search starts at its best match
    };
    const RINK_ROWS_MAX = 80;
    /**
     * Put the list on screen in two steps: the rows that fit a phone's list now, the rest a
     * moment later in small batches. A keystroke that swaps eighty rows for eighty others
     * then paints sixteen before the next letter, not eighty. A newer list cancels an older fill.
     */
    let rinkFillTimer = 0;
    function fillRinkList(wrap, parts) {
        clearTimeout(rinkFillTimer);
        const nodeOf = (x) => x.node || (x.head ? el('div', { class: 'rinks-head' }, [x.head]) : el('p', { class: 'settings-hint' }, [x.hint]));
        const put = (from, to) => { const f = document.createDocumentFragment(); for (let i = from; i < Math.min(to, parts.length); i++) f.appendChild(nodeOf(parts[i])); return f; };
        const FIRST = 16, BATCH = 32;
        wrap.textContent = '';              // the kept rows are only moved, never rebuilt
        wrap.appendChild(put(0, FIRST));
        let at = FIRST;
        const more = () => {
            wrap.appendChild(put(at, at + BATCH));
            at += BATCH;
            if (at < parts.length) rinkFillTimer = setTimeout(more, 50);
        };
        if (at < parts.length) rinkFillTimer = setTimeout(more, 140);
    }

    /* ---------- What's new ---------- */
    Render.whatsNew = function () {
        $('whatsnew-list').innerHTML = CFG.changelog.map(c => `
            <div class="wn-entry">
                <h4>v${escapeHtml(c.v)} <span class="wn-date">${escapeHtml(c.date)}</span></h4>
                <ul>${c.items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
            </div>`).join('');
    };

    /* ---------- Guides ---------- */
    let guidesRenderQueued = false;
    function scheduleGuidesRender() {
        if (guidesRenderQueued) return;
        guidesRenderQueued = true;
        // rAF never fires in a background tab: a timer covers that case
        let done = false;
        const run = () => {
            if (done) return;
            done = true;
            guidesRenderQueued = false;
            Render.guides();
            if (S.pendingGuideOpen && SkateGuides.get(S.pendingGuideOpen)) {
                const gid = S.pendingGuideOpen;
                S.pendingGuideOpen = null;
                Actions.openGuide(gid);
            }
        };
        const fallback = setTimeout(run, document.visibilityState === 'hidden' ? 30 : 400);
        requestAnimationFrame(() => { clearTimeout(fallback); run(); });
    }

    Render.guides = function () {
        if (!window.SkateGuides) return;   // the community code is not loaded (yet)
        if (S.activeGuideId) return Render.guideDetail();
        const guides = SkateGuides.list(S.guideCat || null);
        if (!SkateGuides.loaded && !guides.length) {
            $('guides-list').innerHTML = '<div class="loading">Loading guides from the network…</div>';
            return;
        }
        if (!guides.length) {
            $('guides-list').innerHTML = '<div class="chat-empty"><p>No guides here yet. Be the first to write one.</p></div>';
            return;
        }
        const myPk = SkateChat.getState().myPublicKey;
        $('guides-list').innerHTML = guides.map(g => {
            const cat = CFG.guideCategories[g.category] || {};
            return `
            <div class="guide-card ${g.pinned ? 'pinned' : ''}" data-guide="${g.id}">
                <div class="guide-card-top">
                    ${g.pinned ? '<span class="pin-badge">📌 Pinned</span>' : ''}
                    <span class="guide-cat">${cat.emoji || ''} ${escapeHtml(cat.name || '')}</span>
                </div>
                <h4>${escapeHtml(g.title)}</h4>
                <p class="guide-preview">${escapeHtml(g.body.slice(0, 140))}${g.body.length > 140 ? '…' : ''}</p>
                <div class="guide-card-bottom">
                    <span>${hueDot(g.author)}${escapeHtml(g.authorName || 'Skater')} · ${new Date(g.ts).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}</span>
                    <span>
                        <button class="btn-guide-vote ${SkateGuides.hasVoted(g.id, myPk) ? 'voted' : ''}" data-vote="${g.id}" title="${SkateGuides.hasVoted(g.id, myPk) ? 'Remove your vote' : 'Vote useful'}">⛸️ ${g.votes}</button>
                        💬 ${g.comments.length}
                    </span>
                </div>
            </div>`;
        }).join('');
    };

    Render.guideDetail = function () {
        const g = SkateGuides.get(S.activeGuideId);
        if (!g) { S.activeGuideId = null; return Render.guides(); }
        const cat = CFG.guideCategories[g.category] || {};
        const myPk = SkateChat.getState().myPublicKey;
        const voted = SkateGuides.hasVoted(g.id, myPk);
        $('guide-detail-content').innerHTML = `
            <div class="guide-card-top">
                ${g.pinned ? '<span class="pin-badge">📌 Pinned</span>' : ''}
                <span class="guide-cat">${cat.emoji || ''} ${escapeHtml(cat.name || '')}</span>
            </div>
            <h3>${escapeHtml(g.title)}</h3>
            <p class="guide-byline">${hueDot(g.author)}${escapeHtml(g.authorName || 'Skater')} <span class="pk-tag">${shortPk(g.author)}</span> · ${new Date(g.ts).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
            <div class="guide-body" id="guide-body-text">${escapeHtml(g.body).replace(/\n/g, '<br>')}</div>
            <div class="guide-detail-actions">
                <button class="btn-guide-vote big ${voted ? 'voted' : ''}" data-vote="${g.id}" title="${voted ? 'Remove your vote' : 'Vote useful'}">Useful (${g.votes})</button>
                <button data-guide-copy="${g.id}" title="Copy a link to this guide">Copy link</button>
                <button data-guide-share="${g.id}" title="Share this guide (or a highlighted part) into a chat">Share to chat</button>
            </div>
            <p class="guides-sub">Tip: highlight a sentence before tapping Share to quote just that part.</p>`;

        // comment tree: roots chronological, replies nested one visual level
        const comments = g.comments || [];
        const byId = Object.fromEntries(comments.map(c => [c.id, c]));
        const children = {};
        const roots = [];
        comments.forEach(c => {
            if (c.parentId && byId[c.parentId]) (children[c.parentId] ||= []).push(c);
            else roots.push(c);
        });
        const nodeHtml = (c, depth, parentName) => {
            const cVoted = SkateGuides.hasVoted(c.id, myPk);
            return `
            <li class="comment ${depth ? 'reply' : ''}" data-cid="${c.id}">
                ${depth ? `<span class="reply-to">↪ ${escapeHtml(parentName)}</span>` : ''}
                <div class="comment-head">${hueDot(c.author)}<strong>${escapeHtml(c.authorName)}</strong> <span class="dm-time">${SkateSettings.formatWhen(c.ts)}</span></div>
                <div class="comment-text">${escapeHtml(c.text)}</div>
                <div class="comment-actions">
                    <button class="btn-cvote ${cVoted ? 'voted' : ''}" data-vote="${c.id}" title="${cVoted ? 'Remove your vote' : 'Upvote this comment'}">⛸️ ${c.votes || ''}</button>
                    <button class="btn-creply" data-reply-comment="${c.id}" data-name="${escapeHtml(c.authorName)}">↩ Reply</button>
                </div>
            </li>`;
        };
        const walk = (c, depth, parentName) => {
            let html = nodeHtml(c, depth, parentName);
            (children[c.id] || []).sort((a, b) => a.ts - b.ts)
                .forEach(ch => { html += walk(ch, 1, c.authorName); });
            return html;
        };
        $('guide-comments-title').textContent = `Comments (${comments.length})`;
        $('guide-comments-list').innerHTML = roots.length
            ? roots.map(r => walk(r, 0, null)).join('')
            : '<li class="comment-none">No comments yet. Start the thread.</li>';
    };

    /* ================= Menus (labels from config, availability in code) ================= */
    function A(id, vars = {}) {
        const def = CFG.actions[id];
        const label = def.label.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
        return { label, danger: !!def.danger };
    }

    const Menus = {
        user(pubkey, name) {
            const items = [];
            if (pubkey && pubkey !== SkateChat.getState().myPublicKey) {
                items.push({ ...A('message', { name }), onClick: () => Actions.startDm(pubkey, name) });
                const muted = SkateChat.Mutes.has(pubkey);
                items.push({ ...A(muted ? 'unmute' : 'mute', { name }), onClick: () => SkateChat.Mutes.toggle(pubkey, name) });
            }
            return items;
        },

        message(m, chatState) {
            const items = [];
            const isDm = chatState.viewMode === 'dm';
            const convId = isDm ? chatState.activeDmRecipient : chatState.activeGroup?.id;
            const kind = isDm ? 'dm' : 'group';
            if (m.deleted) return items;
            if (!m.system && !m.localId) {
                items.push({ reactions: SkateChat.REACTIONS, active: Object.keys(m.reacts || {}).filter(e => (m.reacts[e] || []).includes(chatState.myPublicKey)), onPick: (emoji) => SkateChat.react(kind, convId, m.id, emoji) });
            }
            if (!m.system) items.push({ ...A('reply'), onClick: () => Actions.setReply(m) });
            if (m.text) items.push({ ...A('copyText'), onClick: () => copyText(m.text) });
            if (m.type === 'share' && m.data?.programId) items.push({ ...A('openProgram'), onClick: () => { Actions.switchView('programs'); Actions.focusProgram(m.data.programId); } });
            if (m.type === 'guide' && m.data?.guideId) items.push({ ...A('openGuide'), onClick: () => Actions.openGuide(m.data.guideId) });
            if (m.mine && m.status === 'failed' && m.localId) {
                items.push({ ...A('retry'), onClick: () => SkateChat.retryMessage(isDm ? 'dm' : 'group', convId, m.localId) });
            }
            if (m.mine && !m.localId && !m.system) {
                items.push({ ...A('unsend'), onClick: () => { if (confirm('Unsend this message for everyone?')) SkateChat.unsend(kind, convId, m.id); } });
            }
            if (!m.mine && !m.system && !isDm) items.push(...Menus.user(m.fromPubkey, m.from || 'Skater'));
            if (!m.mine && isDm) {
                const muted = SkateChat.Mutes.has(convId);
                items.push({ ...A(muted ? 'unmute' : 'mute', { name: '' }), label: muted ? '🔊 Unmute' : '🔇 Mute', danger: !muted,
                    onClick: () => SkateChat.Mutes.toggle(convId, chatState.activeDmThread?.name) });
            }
            return items;
        },

        conversation() {
            const s = SkateChat.getState();
            const items = [];
            if (s.viewMode === 'dm' && s.activeDmRecipient) {
                const pk = s.activeDmRecipient, name = s.activeDmThread?.name || 'Skater';
                const muted = SkateChat.Mutes.has(pk);
                items.push({ ...A(muted ? 'unmute' : 'mute', { name }), danger: false, onClick: () => SkateChat.Mutes.toggle(pk, name) });
                items.push({ ...A('clearHistory'), onClick: () => { if (confirm('Clear this conversation on this device?')) SkateChat.clearHistory('dm', pk); } });
                items.push({ ...A('deleteThread'), onClick: () => { if (confirm('Delete this DM thread from this device?')) { SkateChat.deleteDmThread(pk); Actions.backToList(); } } });
            } else if (s.activeGroup) {
                const g = s.activeGroup;
                if (!g.isPublic) {
                    items.push({ ...A('copyInvite'), onClick: () => {
                        const inv = SkateChat.getInviteInfo(g.id);
                        if (inv) copyText(inv.url, inv.hasPassword ? 'Invite copied. They will also need the password.' : 'Invite link copied');
                    } });
                    items.push({ ...A('rename'), onClick: async () => {
                        const name = prompt('New group name:', g.name);
                        if (name === null) return;
                        try { await SkateChat.renameGroup(g.id, name); } catch (e) { SkateUI.toast(e.message, 'error'); }
                    } });
                }
                items.push({ ...A('clearHistory'), onClick: () => { if (confirm('Clear messages on this device? Others keep theirs.')) SkateChat.clearHistory('group', g.id); } });
                items.push({ ...A(g.isPublic ? 'leaveRoom' : 'leaveGroup'), onClick: () => {
                    if (confirm(`Leave ${g.name}?`)) { SkateChat.leaveGroup(g.id); Actions.backToList(); }
                } });
            }
            return items;
        },

        programCopy(p, anchor = null) {
            const items = [
                { ...A('copyDetails'), onClick: () => copyText(programText(p)) },
                { ...A('copyLink'), onClick: () => copyText(`${baseUrl()}#p=${P.id(p)}`, 'Link copied') },
                { ...A('addCalendar'), onClick: () => {
                    // the list re-renders every minute, so the anchor may be detached: find it fresh
                    const at = (anchor && document.contains(anchor)) ? anchor : (document.querySelector(`.program-item[data-pid="${P.id(p)}"] .btn-copy`) || document.body);
                    Actions.addToCalendar(p, at);
                } }
            ];
            // This rink → My rinks, right from the card (no scrolling up to the list)
            const key = P.locKey(p);
            if (key && !key.startsWith('name:')) {
                const mine = (SkateSettings.get('myRinks') || []).includes(key);
                items.push({ ...A(mine ? 'removeRink' : 'addRink', { rink: P.location(p) }), onClick: () => {
                    Actions.toggleMyRink(key);
                    SkateUI.toast(mine ? `${P.location(p)} removed from your rinks` : `${P.location(p)} added to your rinks`, 'success', 2200);
                } });
            }
            const off = officialUrl(p);
            if (off) items.push({ ...A('openOfficial', { site: officialSite(p) }), onClick: () => window.open(off, '_blank', 'noopener') });
            // Share rides the community stack: only offered when Chats are on
            if (SkateSettings.get('showChats') !== false) {
                items.push({ ...A('shareChat'), onClick: () => Actions.openSharePicker({ type: 'program', payload: p }) });
            }
            return items;
        },

        /** Add-to-calendar targets — each opens the calendar app with the event filled in. */
        calendar(p) {
            return [
                { ...A('calGoogle'),  onClick: () => openCalendarLink(p, 'google') },
                { ...A('calOutlook'), onClick: () => openCalendarLink(p, 'outlook') },
                { ...A('calIcs'),     onClick: () => openIcs(p) }
            ];
        },

        /** Status line: freshness details, the dropped-session switch, refresh, the City doorbell. */
        status() {
            const meta = SkateAPI.getMetadata();
            const fmt = x => x ? new Date(x).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
            const st = SkateAlerts.liveStats;
            // v3.12: when each source was read lives on its own sheet (the "checked" part of the line)
            const items = [
                { label: `Schedule data: ${fmt(meta?.lastUpdated)}${meta?.counts?.duplicatesRemoved ? ` · ${meta.counts.duplicatesRemoved} duplicate row${meta.counts.duplicatesRemoved === 1 ? '' : 's'} merged` : ''}`, onClick: () => Actions.openStatus() },
                { label: S.behind ? `⚠️ Data status: ${S.behind} source${S.behind === 1 ? '' : 's'} behind` : `Data status: checked ${S.checkedAt ? SkateSettings.formatTime(S.checkedAt) : 'each source'}`, onClick: () => Actions.openStatus() }
            ];
            if (st?.missing) items.push({ label: S.showDropped ? 'Hide the sessions toronto.ca no longer lists' : `Show the ${st.missing} session${st.missing === 1 ? '' : 's'} toronto.ca no longer lists`, onClick: () => Actions.setFlag('dropped', !S.showDropped) });
            items.push({ label: 'Refresh now', onClick: () => Actions.refreshPrograms() });
            items.push({ label: 'Ask for a fresh pull from the City', onClick: () => Actions.requestCityRefresh() });
            if (!S.paidVisible && S.paidMatching) items.push({ label: `Show ${S.paidMatching} paid sessions`, onClick: () => Actions.setFlag('free', false) });
            return items;
        },

        /** v3.16: the day part of the bar: the When choices from Filters. */
        when() {
            const cur = S.dateFrom ? null : S.day;
            return [['', 'Any day'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['weekend', 'Weekend'], ...CFG.days.map(d => [d, d])]
                .map(([id, label]) => ({ label: `${cur === id ? '✓ ' : '\u2007\u2007 '}${label}`, onClick: () => Actions.setDay(id) }));
        },

        /** v3.12: the ▾ beside Calendar. Four calendars, each with its own colour. */
        calTypes() {
            const cur = S.calMode ? calType() : null;
            return CFG.calTypes.map(t => ({ label: `${cur === t.id ? '✓ ' : '\u2007\u2007 '}${t.label}`, cls: `cal-t cal-t-${t.id}`, onClick: () => Actions.setCalType(t.id) }));
        },

        /** v3.12: the Within N km pill. */
        radius() {
            const items = [{ label: `${S.radius ? '\u2007\u2007 ' : '✓ '}Any distance`, onClick: () => Actions.setRadius(null) }];
            CFG.radiusOptions.forEach(km => items.push({ label: `${S.radius === km ? '✓ ' : '\u2007\u2007 '}Within ${km} km`, onClick: () => Actions.setRadius(km) }));
            return items;
        },

        /** Age-group picker behind a type pill (multi-select; stays open while you pick). */
        subTypes(cat) {
            const f = filterFacets().cats[cat];
            if (!f) return [];
            const sel = S.types[cat];
            const reopen = () => { const a = $('active-filters').querySelector(`.pill.type[data-pill="type:${cat}"]`); if (a) Popover.open(a, Menus.subTypes(cat), subMenuTitle(cat)); };
            const items = [];
            const ks = cat === 'hockey' ? kindsPresent() : [];      // v3.12.2: the kinds first, then the ages
            const cur = kindNow();
            if (ks.length > 1) {          // v3.14: ticks, both on with Hockey; untick one to hide it
                ks.forEach(id => { const on = !cur || cur === id; items.push({ label: `${on ? '✓ ' : '\u2007\u2007 '}${KIND_OF(id).label} · ${(f.kinds || {})[id] || 0}`, onClick: () => { Actions.setKind(id, !on); reopen(); } }); });
            }
            const n = ageCounts(cat, f);
            items.push({ label: `${sel === 'all' ? '✓ ' : '\u2007\u2007 '}Every age group · ${cur ? (f.kinds[cur] || 0) : f.n}`, cls: ks.length > 1 ? 'popover-sep' : '', onClick: () => { Actions.setType(cat, null, true); reopen(); } });
            agesShown(cat, f).forEach(x => {
                const on = sel === 'all' || (Array.isArray(sel) && sel.includes(x.id));
                items.push({ label: `${on ? '✓ ' : '\u2007\u2007 '}${x.label} · ${n[x.id] || 0}`, onClick: () => { Actions.setType(cat, x.id, !on); reopen(); } });
            });
            return items;
        },

        /** The Other pill: its kinds, each a toggle (stays open while you pick). */
        otherTypes() {
            const f = filterFacets().cats;
            const present = otherMembersAll();                      // v3.15.2: none of them vanishes under your other filters
            const reopen = () => { const a = $('active-filters').querySelector(`.pill.type[data-pill="type:${OTHER_KEY}"]`); if (a) Popover.open(a, Menus.otherTypes(), 'Other kinds'); };
            const allOn = otherMembersAll().every(c => S.types[c]);
            const items = [{ label: `${allOn ? '✓ ' : '\u2007\u2007 '}Everything in Other`, onClick: () => { Actions.setType(OTHER_KEY, null, true); reopen(); } }];
            present.forEach(c => items.push({
                label: `${S.types[c] ? '✓ ' : '\u2007\u2007 '}${CAT_LABEL(c)} · ${f[c] ? f[c].n : 0}`,
                onClick: () => { Actions.setType(c, null, !S.types[c]); reopen(); }
            }));
            return items;
        },

        /** City picker behind the standing city pill (multi-select; stays open while you pick). */
        cities() {
            const f = citiesShown(filterFacets());
            const reopen = () => { const a = $('active-filters').querySelector('.pill.city'); if (a) Popover.open(a, Menus.cities(), 'Cities'); };
            const items = [{ label: `${S.cities.length ? '\u2007\u2007 ' : '✓ '}All cities`, onClick: () => { Actions.setCities([]); } }];
            cityKeys(f).forEach(c => items.push({
                label: `${S.cities.includes(c) ? '✓ ' : '\u2007\u2007 '}${c} · ${f[c]}`,
                onClick: () => { Actions.toggleCity(c); reopen(); }
            }));
            return items;
        },

        /** Weather chip: current reading + the spot picker. */
        weather() {
            const w = SkateWeather.current;
            const cur = SkateWeather.selectedId();
            const user = SkateGeo.getUserLocation();
            const items = [];
            if (w) items.push({ label: `${w.emoji} ${w.text}, ${w.temp}°C, feels like ${w.feels}°C (Open-Meteo)`, onClick: () => SkateWeather.load(true) });
            items.push({ label: `${cur === 'auto' ? '✓ ' : '\u2007\u2007'}${user ? user.label : 'Toronto (or your location once set)'}`, onClick: () => Actions.pickWeatherSpot('auto') });
            SkateWeather.spots().forEach(sp => items.push({ label: `${cur === sp.id ? '✓ ' : '\u2007\u2007'}${sp.label}`, onClick: () => Actions.pickWeatherSpot(sp.id) }));
            return items;
        },

        /** Tapping a session block in the week calendar. */
        calBlock(p, anchor = null) {
            const fav = SkateFavorites.has(p);
            const items = [
                { label: fav ? 'Remove from saved' : 'Save this session', onClick: () => { Actions.toggleSaved(p); } },
                { label: 'Show in the list', onClick: () => {
                    S.calMode = false;
                    SkateSettings.set('calMode', false);
                    Actions.focusProgram(P.id(p));
                } }
            ];
            if (p.Paid && p.RegistrationUrl) {
                items.push({ label: 'Register on the venue site ↗', onClick: () => window.open(p.RegistrationUrl, '_blank', 'noopener') });
            }
            // programCopy already appends the chats-gated "Share to chat…"
            items.push(...Menus.programCopy(p, anchor));
            return items;
        }
    };

    /* ================= Actions (named intents) ================= */
    const Actions = {};

    Actions.switchView = view => {
        Render.switchView(view);
        if (view === 'chats' && !chatBooted) Render.chatLoading();
        if (chatBooted) SkateChat.setViewOpen(chatsViewOnScreen());
    };

    /** The filter pipeline, pure: state → sorted array (also sets S.paidMatching). */
    /**
     * Every filter as its own check (v3.14). The list needs all of them; each part of the
     * Filters sheet counts with all of them but its own (filterFacets).
     */
    function filterChecks() {
        const mine = new Set(SkateSettings.get('myRinks') || []);
        const nowMs = Date.now();
        const todayKey = SkateTime.todayKey(), tomorrowKey = SkateTime.addDays(todayKey, 1);
        const term = S.search.toLowerCase();
        const postalTerm = term.replace(/\s+/g, '');   // "M5A3S5" finds "M5A 3S5"
        const dayIsRel = ['today', 'tomorrow', 'weekend'].includes(S.day);
        // v3.12: only what is within N km of the reader's spot. One distance per rink, not per session.
        const radius = S.radius && SkateGeo.getUserLocation() ? S.radius : null;
        const kmByRink = new Map();
        const kmOf = (p) => {
            const k = P.locKey(p);
            let d = kmByRink.get(k);
            if (d === undefined) { d = SkateGeo.distanceForProgram(p); kmByRink.set(k, d); }
            return d;
        };
        const rest = (p) => {
            if (!S.showDropped && SkateAlerts.isDropped(p)) return false;   // toronto.ca is the ground truth
            if (S.savedOnly && !SkateFavorites.has(p)) return false;
            if (S.rinkScope === 'mine' && mine.size && !mine.has(P.locKey(p))) return false;
            if (S.nearRink && P.locKey(p) !== S.nearRink.key) return false;
            if (radius != null) { const d = kmOf(p); if (d == null || d > radius) return false; }
            if (term && !(
                P.activity(p).toLowerCase().includes(term) ||
                P.location(p).toLowerCase().includes(term) ||
                akaOf(P.locKey(p)).hay.includes(term) ||               // v3.12: "Barbara Ann Scott" finds College Park
                (p.Address || '').toLowerCase().includes(term) ||
                (p.District || '').toLowerCase().includes(term) ||
                P.city(p).toLowerCase().includes(term) ||
                (postalTerm && (p.PostalCode || '').toLowerCase().replace(/\s+/g, '').includes(postalTerm)))) return false;
            if (S.dateFrom) { const d = P.dateStr(p).slice(0, 10); if (d < S.dateFrom || d > S.dateTo) return false; }   // v3.16
            if (S.day) {
                const d = P.dateStr(p).slice(0, 10), dow = p['Day of Week'];
                if (S.day === 'today' && d !== todayKey) return false;
                if (S.day === 'tomorrow' && d !== tomorrowKey) return false;
                if (S.day === 'weekend' && dow !== 'Saturday' && dow !== 'Sunday') return false;
                if (!dayIsRel && dow !== S.day) return false;
            }
            // Parsed bounds so a stray "None"/"" can never silently exclude a row
            if (S.age !== null && !(S.age >= (P.age(p['Age Min']) ?? 0) && S.age <= (P.age(p['Age Max']) ?? 999))) return false;
            // Past filter on the real END time in Toronto — an event disappears
            // the minute it ends (not at midnight), and in-progress ones stay.
            if (!S.showPast && SkateTime.status(p, nowMs).phase === 'ended') return false;
            return true;
        };
        return {
            rest,
            type: (p) => P.matchesTypes(p),
            city: (p) => !S.cities.length || S.cities.includes(P.city(p)),
            paid: (p) => S.paidVisible || !p.Paid
        };
    }

    function computeFiltered() {
        const c = filterChecks();
        let result = S.programs.filter(p => c.rest(p) && c.type(p) && c.city(p));

        // Paid exclusion runs LAST so the "N paid hidden" hint reflects every
        // other active filter — no phantom counts.
        S.paidMatching = result.filter(p => p.Paid).length;
        if (!S.paidVisible) result = result.filter(p => !p.Paid);

        // Order by actual start instant (date+time, Toronto); "nearest" needs a saved point
        if (S.sort === 'near' && SkateGeo.getUserLocation()) {
            result.sort((a, b) => {
                const da = SkateGeo.distanceForProgram(a), db = SkateGeo.distanceForProgram(b);
                if (da == null && db == null) return SkateTime.sortEpoch(a) - SkateTime.sortEpoch(b);
                if (da == null) return 1;
                if (db == null) return -1;
                return (da - db) || (SkateTime.sortEpoch(a) - SkateTime.sortEpoch(b));
            });
        } else {
            result.sort((a, b) => SkateTime.sortEpoch(a) - SkateTime.sortEpoch(b));
        }
        return result;
    }

    /**
     * @param keepLimit true for background re-runs (the 1-minute status
     * ticker) — keeps however many rows the reader expanded to.
     */
    Actions.applyFilters = function (keepLimit = false) {
        S.filtered = computeFiltered();
        if (!keepLimit) S.limit = 30;
        Render.programs();
    };

    /* ---------- Filters sheet + pills ---------- */
    function persistFilters() {
        if (!S.types.hockey) S.kinds = null;                   // v3.12.2: a kind only ever narrows hockey
        SkateSettings.set('hockeyKinds', S.kinds);
        SkateSettings.set('typeSel', S.types);
        SkateSettings.set('cities', S.cities);
        SkateSettings.set('freeOnly', !S.paidVisible);
        SkateSettings.set('rinkScope', S.rinkScope);
        SkateSettings.set('sort', S.sort);
        SkateSettings.set('radius', S.radius);
    }
    /** Re-render after a filter change: sheet (if open) + list. */
    function filtersChanged() {
        persistFilters();
        if (!$('filters-modal').classList.contains('hidden')) rerenderFilters();
        Actions.applyFilters();
    }
    /** Re-render the sheet without the rows jumping under the finger. */
    function rerenderFilters() {
        const body = $('filters-body');
        const keep = body.scrollTop;
        Render.filters();
        body.scrollTop = keep;
    }

    Actions.openFilters = function () { Render.filters(); Modal.open('filters-modal'); };
    Actions.closeFilters = function () { Modal.close('filters-modal'); };

    /** Category checkbox (sub=null) or one age group under it. */
    Actions.setType = function (cat, sub, on) {
        const types = { ...S.types };
        if (cat === OTHER_KEY) {
            otherMembersAll().forEach(c => { if (on) types[c] = 'all'; else delete types[c]; });
        } else if (!sub) {
            if (on) types[cat] = 'all'; else delete types[cat];
        } else {
            // the age groups on offer (v3.12.3: for hockey with a kind picked, the ones in that kind)
            const fc = filterFacets().cats[cat];
            const present = fc ? agesShown(cat, fc).map(x => x.id) : [];
            let sel = types[cat] === 'all' ? [...present] : Array.isArray(types[cat]) ? [...types[cat]] : [];
            sel = on ? [...new Set([...sel, sub])] : sel.filter(x => x !== sub);
            if (!sel.length) delete types[cat];
            else if (present.every(x => sel.includes(x))) types[cat] = 'all';
            else types[cat] = sel;
        }
        S.types = types;
        if (sub) S.expandedCats[cat] = true;
        filtersChanged();
    };
    /**
     * The kind of hockey (v3.12.3): one tap picks one, or Any (null). Either way Hockey is on:
     * picking a kind means "show me that hockey". An age group picked before that has no
     * sessions in the new kind is dropped, so the list is never empty for a reason nobody sees.
     */
    Actions.setKind = function (kind, on) {
        if (kind === 'other' || !CFG.hockeyKinds.some(x => x.id === kind)) return;
        // v3.14: a tick like an age group's. Hockey on = both ticked; untick one and only the other shows;
        // untick both and Hockey is off; with Hockey off, the first one ticked turns it on with just that one.
        const present = kindsPresent();
        let sel = !S.types.hockey ? [] : kindNow() ? [kindNow()] : [...present];
        sel = on ? [...new Set([...sel, kind])] : sel.filter(x => x !== kind);
        const types = { ...S.types };
        if (!sel.length) { delete types.hockey; S.kinds = null; S.types = types; filtersChanged(); return; }
        if (!types.hockey) types.hockey = 'all';
        const k = sel.length === 1 && present.length > 1 ? sel[0] : null;
        S.kinds = k ? [k] : null;
        if (k && Array.isArray(types.hockey)) {
            const f = filterFacets().cats.hockey, n = (f && f.subsBy && f.subsBy[k]) || {};
            const left = types.hockey.filter(x => n[x]);
            types.hockey = left.length ? left : 'all';
        }
        S.types = types;
        S.expandedCats.hockey = true;
        filtersChanged();
    };
    Actions.toggleCity = function (c) {
        S.cities = S.cities.includes(c) ? S.cities.filter(x => x !== c) : [...S.cities, c];
        filtersChanged();
    };
    Actions.setCities = function (list) { S.cities = list; filtersChanged(); };
    Actions.setDay = function (d) { S.day = d || ''; S.dateFrom = null; S.dateTo = null; filtersChanged(); };
    /** v3.16: one day or a range from the bar's date picker (no `from` = any date). It replaces the When choice. */
    Actions.setDates = function (from, to) {
        const ok = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);
        if (ok(from)) { S.dateFrom = from; S.dateTo = ok(to) && to >= from ? to : from; S.day = ''; }
        else { S.dateFrom = null; S.dateTo = null; }
        filtersChanged();
    };

    /* ---------- v3.16: the day bar: the day at the top of the list, the dates you picked, the count, the weather ---------- */
    const mdLabel = (k) => parseLocalDate(k).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
    const wdLabel = (k) => parseLocalDate(k).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
    /** "Tue, Nov 24" for one day; "Nov 24 – 30" or "Nov 28 – Dec 3" for a range. */
    function rangeLabel(from, to) {
        if (!to || from === to) return wdLabel(from);
        return from.slice(0, 7) === to.slice(0, 7) ? `${mdLabel(from)} – ${Number(to.slice(8, 10))}` : `${mdLabel(from)} – ${mdLabel(to)}`;
    }
    function setBarBtn(btn, text, on) {
        if (!btn) return;
        if (btn.firstChild && btn.firstChild.nodeType === 3) btn.firstChild.nodeValue = text;
        else btn.insertBefore(document.createTextNode(text), btn.firstChild);
        btn.classList.toggle('on', !!on);
    }
    /** The bar's two left items: the day (or the When choice in force) and its date (or the dates picked). */
    Render.dayBar = function (day) {
        if (day !== undefined) S.barDay = day || null;
        const todayKey = SkateTime.todayKey(), tomorrowKey = SkateTime.addDays(todayKey, 1);
        // the day the bar is about: the one at the top of the list; with nothing listed (today's sessions all over,
        // say), the day you picked, else today. v3.16.2: never "Any day".
        const d = (S.calMode ? null : S.barDay) || S.dateFrom || todayKey;
        const oneDay = !!S.dateFrom && S.dateFrom === S.dateTo;
        const rel = d === todayKey ? 'Today' : d === tomorrowKey ? 'Tomorrow' : '';
        const weekday = parseLocalDate(d).toLocaleDateString('en-CA', { weekday: 'long' });
        // a day you picked is named by its weekday ("Tuesday · Nov 24"); otherwise Today, Tomorrow or the weekday
        const when = S.day ? (S.day === 'today' ? 'Today' : S.day === 'tomorrow' ? 'Tomorrow' : S.day === 'weekend' ? 'Weekend' : S.day)
            : oneDay ? weekday : (rel || weekday);
        setBarBtn($('db-when'), when, !!S.day);
        // "Wednesday, Nov 25" when the first part says Today, Tomorrow or a When choice; "Nov 26" when it already names the weekday
        let long, short = mdLabel(d);
        if (S.dateFrom) long = short = oneDay ? mdLabel(S.dateFrom) : rangeLabel(S.dateFrom, S.dateTo);
        else long = (S.day || rel) ? parseLocalDate(d).toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' }) : short;
        const db = $('db-date');
        db.querySelector('.db-long').textContent = long;
        db.querySelector('.db-short').textContent = short;
        db.classList.toggle('on', !!S.dateFrom);
        $('day-bar').classList.toggle('today', d === todayKey && !S.day && !S.dateFrom);
    };
    /** Which day is at the top of the list, under the bar: the last separator that has gone under it. */
    let spyRaf = 0;
    function spyDay() {
        spyRaf = 0;
        const list = $('program-list'), bar = $('day-bar');
        if (!bar || !bar.offsetParent || S.calMode || !list || !list.offsetParent) return;
        // the line is the bar's bottom edge; at the very end of the list (where the last day's separator
        // can never reach the bar) it is the bottom of what you can see
        let sc = list.parentElement;
        while (sc && sc !== document.body && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight + 1)) sc = sc.parentElement;
        if (!sc || sc === document.body) sc = document.scrollingElement || document.documentElement;
        const atEnd = sc.scrollTop > 0 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
        const limit = atEnd ? (sc === (document.scrollingElement || document.documentElement) ? innerHeight : sc.getBoundingClientRect().bottom) : bar.getBoundingClientRect().bottom + 1;
        let day = list.dataset.firstDay || null;
        for (const h of list.querySelectorAll('.day-head[data-day]:not(.first)')) {
            if (h.getBoundingClientRect().top > limit) break;
            day = h.dataset.day;
        }
        if (day !== S.barDay) Render.dayBar(day);
    }
    /** v3.16.5: the one-time "tap ♡ to save" tip, once someone has scrolled past a few sessions (just in time, not up front). */
    function maybeHeartTip() {
        if (SkateSettings.get('heartHintDone') || S.calMode) return;
        const items = $('program-list')?.querySelectorAll('.program-item');
        if (!items || items.length < 6 || !$('day-bar')) return;
        if (items[3].getBoundingClientRect().bottom > $('day-bar').getBoundingClientRect().bottom) return;   // the 4th session is still in view
        SkateSettings.set('heartHintDone', true);
        SkateUI.toast('Tip: tap ♡ on a session to save it. Saved sessions come back up top.', 'info', 7000);
    }
    document.addEventListener('scroll', () => { if (!spyRaf) spyRaf = requestAnimationFrame(() => { spyDay(); maybeHeartTip(); }); }, { capture: true, passive: true });

    /** Sessions per day under every filter but the day ones: what the date picker marks and counts. */
    function sessionsByDay() {
        const keep = [S.day, S.dateFrom, S.dateTo, S.paidMatching];
        S.day = ''; S.dateFrom = null; S.dateTo = null;
        let list = [];
        try { list = computeFiltered(); } finally { [S.day, S.dateFrom, S.dateTo, S.paidMatching] = keep; }
        const m = new Map();
        list.forEach(p => { const d = P.dateStr(p).slice(0, 10); if (d) m.set(d, (m.get(d) || 0) + 1); });
        return m;
    }
    /** v3.16: a month calendar under the bar's date: tap a day, tap another for a range, then Show. */
    Actions.openDates = function () {
        const counts = sessionsByDay();
        const today = SkateTime.todayKey();
        const keys = [...counts.keys()].sort();
        const first = S.showPast && keys.length && keys[0] < today ? keys[0] : today;
        const last = keys.length && keys[keys.length - 1] > today ? keys[keys.length - 1] : SkateTime.addDays(today, 30);
        let pick = S.dateFrom ? { from: S.dateFrom, to: S.dateTo } : null;
        let month = (S.dateFrom || today).slice(0, 7);
        const shift = (m, n) => { const x = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; };
        const total = (a, b) => { let n = 0; counts.forEach((c, k) => { if (k >= a && k <= b) n += c; }); return n; };
        const box = el('div', { class: 'dp' });
        const draw = () => {
            box.innerHTML = '';
            const y = Number(month.slice(0, 4)), mo = Number(month.slice(5, 7)) - 1;
            box.appendChild(el('div', { class: 'dp-head' }, [
                el('button', { type: 'button', class: 'dp-nav', dataset: { nav: '-1' }, 'aria-label': 'Previous month', disabled: month <= first.slice(0, 7) ? '' : null }, ['‹']),
                el('strong', { class: 'dp-month' }, [new Date(y, mo, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })]),
                el('button', { type: 'button', class: 'dp-nav', dataset: { nav: '1' }, 'aria-label': 'Next month', disabled: month >= last.slice(0, 7) ? '' : null }, ['›'])
            ]));
            const grid = el('div', { class: 'dp-grid' });
            ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach(w => grid.appendChild(el('span', { class: 'dp-wd', 'aria-hidden': 'true' }, [w])));
            const lead = new Date(y, mo, 1).getDay(), days = new Date(y, mo + 1, 0).getDate();
            for (let i = 0; i < lead; i++) grid.appendChild(el('span', { class: 'dp-pad' }, []));
            for (let n = 1; n <= days; n++) {
                const k = `${month}-${String(n).padStart(2, '0')}`, c = counts.get(k) || 0;
                const cls = ['dp-day'];
                if (k === today) cls.push('today');
                if (!c) cls.push('none');
                if (pick && k >= pick.from && k <= pick.to) cls.push('sel', k === pick.from ? 'start' : '', k === pick.to ? 'end' : '');
                grid.appendChild(el('button', {
                    type: 'button', class: cls.filter(Boolean).join(' '), dataset: { d: k }, disabled: k < first || k > last ? '' : null,
                    'aria-label': `${parseLocalDate(k).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })}, ${c} session${c === 1 ? '' : 's'}`
                }, [String(n)]));
            }
            box.appendChild(grid);
            const n = pick ? total(pick.from, pick.to) : 0;
            box.appendChild(el('p', { class: 'dp-hint' }, [pick ? (pick.from === pick.to ? `${rangeLabel(pick.from)}. Tap another day for a range.` : rangeLabel(pick.from, pick.to)) : 'Tap a day, then another for a range.']));
            box.appendChild(el('div', { class: 'dp-foot' }, [
                el('button', { type: 'button', class: 'btn-small dp-any', dataset: { any: '1' } }, ['Any date']),
                el('button', { type: 'button', class: 'btn-primary dp-go', dataset: { go: '1' }, disabled: pick ? null : '' }, [pick ? `Show ${n.toLocaleString('en-CA')} session${n === 1 ? '' : 's'}` : 'Show'])
            ]));
        };
        box.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b || b.disabled) return;
            if (b.dataset.nav) { month = shift(month, Number(b.dataset.nav)); draw(); return; }
            if (b.dataset.any) { Popover.close(); Actions.setDates(null); return; }
            if (b.dataset.go) { Popover.close(); if (pick) Actions.setDates(pick.from, pick.to); return; }
            const k = b.dataset.d;
            if (!k) return;
            pick = (!pick || pick.from !== pick.to || k < pick.from) ? { from: k, to: k } : { from: pick.from, to: k };
            draw();
        });
        draw();
        Popover.open($('db-date'), [{ node: box }], 'One day, or a range', { width: 300 });
    };
    Actions.setAge = function (v) { const n = parseInt(v, 10); S.age = Number.isFinite(n) ? n : null; filtersChanged(); };
    Actions.setSort = function (id) {
        S.sort = id;
        if (id === 'near' && !SkateGeo.getUserLocation()) {
            Modal.close('filters-modal');
            Actions.openRinks({ ask: 'Nearest first needs a spot to measure from. Type a place or a postal code, or tap Near me.' });
        }
        filtersChanged();
    };
    /** v3.12: the Data status sheet (the "checked" part of the status line). */
    Actions.openStatus = function () {
        S.statusAll = false;
        Render.dataStatus();
        $('status-body').scrollTop = 0;
        Modal.open('status-modal');
    };
    /** v3.12: only sessions within `km` of the reader's spot (null = any distance). Needs a spot: asks for one first. */
    Actions.setRadius = function (km) {
        const v = CFG.radiusOptions.includes(km) ? km : null;
        if (v && !SkateGeo.getUserLocation()) {
            S.radiusWanted = v;
            Modal.close('filters-modal');
            Actions.openRinks({ ask: `Within ${v} km needs a starting point. Type a place or a postal code, or tap Near me: the filter applies as soon as it is set.` });
            return;
        }
        S.radius = v; S.radiusWanted = null;
        filtersChanged();
    };
    /** saved / past / mine / paid switches (Filters sheet + status popover + pills). */
    Actions.setFlag = function (flag, on) {
        if (flag === 'saved') S.savedOnly = !!on;
        else if (flag === 'past') S.showPast = !!on;
        else if (flag === 'paid') S.paidVisible = !!on;
        else if (flag === 'free') S.paidVisible = !on;
        else if (flag === 'dropped') S.showDropped = !!on;
        else if (flag === 'mine') {
            const keys = SkateSettings.get('myRinks') || [];
            if (on && !keys.length) { Modal.close('filters-modal'); Actions.openRinks(); return; }
            S.rinkScope = on ? 'mine' : 'all';
            if (on && !S.paidVisible) {
                // every one of my rinks paid-only? show them rather than an empty list
                const splits = keys.map(k => upcomingSplit(k));
                if (splits.some(sp => sp.paid > 0) && splits.every(sp => sp.free === 0)) ensurePaidVisibleFor(keys.find(k => upcomingSplit(k).paid > 0), 'Your rinks');
            }
        }
        filtersChanged();
    };
    Actions.resetFilters = function () {
        S.types = {}; S.cities = []; S.day = ''; S.age = null; S.savedOnly = false;
        S.showPast = false; S.nearRink = null; S.rinkScope = 'all'; S.sort = 'time'; S.paidVisible = true;
        S.showDropped = false; S.moreFilters = false; S.expandedCats = {}; S.radius = null; S.radiusWanted = null; S.dateFrom = null; S.dateTo = null;
        filtersChanged();
    };
    /** Tapping a pill removes that one filter (or toggles ⭐ My rinks). */
    Actions.removePill = function (key) {
        if (key === 'mine') return Actions.setFlag('mine', S.rinkScope !== 'mine');
        if (key === `type:${OTHER_KEY}`) { const t = { ...S.types }; OTHER_GROUP.forEach(c => delete t[c]); S.types = t; }
        else if (key.startsWith('type:')) { const t = { ...S.types }; delete t[key.slice(5)]; S.types = t; }
        else if (key.startsWith('city:')) S.cities = S.cities.filter(c => c !== key.slice(5));
        else if (key === 'day') S.day = '';
        else if (key === 'dates') { S.dateFrom = null; S.dateTo = null; }
        else if (key === 'age') S.age = null;
        else if (key === 'saved') S.savedOnly = false;
        else if (key === 'near') S.nearRink = null;
        else if (key === 'paid') S.paidVisible = true;
        else if (key === 'past') S.showPast = false;
        else if (key === 'dropped') S.showDropped = false;
        else if (key === 'cities') S.cities = [];
        else if (key === 'sort') S.sort = 'time';
        else if (key === 'radius') S.radius = null;
        filtersChanged();
    };
    Actions.setCalMode = function (on) {
        S.calMode = !!on;
        SkateSettings.set('calMode', S.calMode);
        Render.programs();
    };
    /** v3.12: pick a calendar from the ▾ beside Calendar (and show it). 'week' is the grid; the rest are the day planner's views. */
    Actions.setCalType = function (type) {
        if (!CFG.calTypes.some(t => t.id === type)) return;
        SkateSettings.set('cal2', type !== 'week');
        if (type !== 'week') { S.cal2By = type; SkateSettings.set('cal2By', type); }
        S.calMode = true;
        SkateSettings.set('calMode', true);
        Render.programs();
    };

    /** Calendar 2.0: pick a day on the strip. */
    Actions.cal2SetDay = function (day) {
        S.cal2Day = day;
        Render.calendar();
    };

    /** Calendar 2.0: group by time of day or by rink (remembered). */
    Actions.cal2SetBy = function (by) {
        S.cal2By = by === 'rink' || by === 'distance' ? by : 'time';
        SkateSettings.set('cal2By', S.cal2By);
        Render.calendar();
    };

    /** Calendar 2.0: show or hide today's ended sessions. */
    Actions.cal2ToggleEnded = function () {
        S.cal2ShowEnded = !S.cal2ShowEnded;
        Render.calendar();
    };

    /** One tap, the right app: Apple devices get the .ics (Calendar), Android gets Google Calendar, other desktops pick. */
    Actions.addToCalendar = function (p, anchor) {
        if (isApple()) return openIcs(p);
        if (isAndroid()) return openCalendarLink(p, 'google');
        const at = (anchor && document.contains(anchor)) ? anchor : (document.querySelector(`.program-item[data-pid="${P.id(p)}"] .btn-copy`) || document.body);
        Popover.open(at, Menus.calendar(p), 'Add to calendar');
    };

    Actions.focusProgram = function (pid) {
        const find = () => S.filtered.findIndex(p => P.id(p) === pid);
        let idx = find();
        if (idx === -1) {
            // widen the net: clear every filter, include past + paid, all rinks
            // (session-only — the persisted prefs are untouched)
            S.types = {}; S.cities = []; S.search = ''; S.day = ''; S.age = null; S.savedOnly = false;
            S.showPast = true; S.paidVisible = true; S.rinkScope = 'all'; S.nearRink = null;
            $('search-input').value = '';
            Actions.applyFilters();
            idx = find();
        }
        if (idx === -1) return SkateUI.toast('That session is not in the current schedule anymore', 'error');
        if (S.calMode) { S.calMode = false; }
        if (idx >= S.limit) S.limit = idx + 1;
        Render.programs();
        requestAnimationFrame(() => flash(document.querySelector(`.program-item[data-pid="${pid}"]`)));
    };

    Actions.pickWeatherSpot = function (id) {
        SkateWeather.setSpot(id).then(() => Render.weather());
    };

    /** Picking a paid-only rink (Markham, Canlan) with Paid off would show
     *  nothing — turn Paid on for them and say so. */
    function ensurePaidVisibleFor(key, what) {
        if (S.paidVisible) return;
        const sp = upcomingSplit(key);
        if (sp.free === 0 && sp.paid > 0) {
            S.paidVisible = true;
            SkateSettings.set('freeOnly', false);
            SkateUI.toast(`${what || 'That rink'} only has paid sessions. Paid is now on so they show.`, 'info', 4000);
        }
    }

    Actions.toggleMyRink = function (key) {
        const mine = new Set(SkateSettings.get('myRinks') || []);
        mine.has(key) ? mine.delete(key) : mine.add(key);
        SkateSettings.set('myRinks', [...mine]);
        if (mine.has(key)) ensurePaidVisibleFor(key);
        if (!mine.size && S.rinkScope === 'mine') { S.rinkScope = 'all'; SkateSettings.set('rinkScope', 'all'); }
        if (!$('rinks-modal').classList.contains('hidden')) { Render.rinks(); SkateMap.refresh(); }
        Actions.applyFilters(true);
    };

    /* ---------- Rinks & map ---------- */
    /** The search box's two helpers: the clear ✕, and "measure distances from what I typed". */
    function syncRinkSearch() {
        const raw = $('rinks-search').value.trim();
        $('btn-rinks-search-clear').classList.toggle('hidden', !$('rinks-search').value);
        const from = $('btn-locator-search');
        from.classList.toggle('hidden', raw.length < 3);
        from.textContent = raw.length >= 3 ? `📍 Measure distances from “${raw.length > 30 ? raw.slice(0, 29) + '…' : raw}”` : '';
    }
    let rinkMapTimer = 0, rinkListFrame = 0;
    /**
     * Typing in the rink search. The list follows on the next frame (several letters inside one
     * frame cost one pass, and rows are moved, not rebuilt); the map waits for a pause, then
     * only adds or removes the pins that changed and jumps to them without an animation, so
     * it never fights the keyboard (v3.12.1: it used to rebuild every pin, redraw the list a
     * second time and fly there, at every pause).
     */
    Actions.rinkSearchTyped = function () {
        syncRinkSearch();
        if (!rinkListFrame) rinkListFrame = requestAnimationFrame(() => { rinkListFrame = 0; Render.rinks(); });
        clearTimeout(rinkMapTimer);
        rinkMapTimer = setTimeout(() => { SkateMap.syncPins(); SkateMap.fitPins({ animate: false }); }, 300);
    };
    Actions.clearRinkSearch = function (focus = true) {
        $('rinks-search').value = '';
        Actions.rinkSearchTyped();
        if (focus) $('rinks-search').focus();
    };

    Actions.openRinks = async function (opts = {}) {
        S.rinksAsk = typeof opts.ask === 'string' ? opts.ask : '';
        // What is typed in the schedule's search box carries over when it names a place
        // ("Scarborough", a street, a rink): the map opens already narrowed to it.
        // (read from the box itself: the schedule search is debounced, so S.search can lag a fast tap)
        const carried = ($('search-input').value || '').trim();
        const carry = carried && SkateGeo.rinks.some(r => rinkMatchesQuery(r, foldText(carried)));
        $('rinks-search').value = carry ? carried : '';
        syncRinkSearch();
        Render.rinks();
        warmRinkRows();     // v3.12.1: the rest of the rows, built while nobody is typing
        try {
            await SkateMap.open(opts);   // shows #rinks-modal, lazy-loads Leaflet
            if (S.rinksAsk && !(window.matchMedia && matchMedia('(pointer: coarse)').matches)) $('rinks-search').focus();   // a phone's keyboard opens on the reader's own tap
        } catch (e) {
            SkateUI.toast('The map could not load. The rink list still works.', 'error');
        }
    };
    Actions.closeRinks = function () { SkateMap.close(); };

    /** After the user's point changes: distances everywhere, map dot, list order. */
    function locationChanged() {
        // v3.12: a radius picked before there was a spot starts counting now; no spot, no radius
        if (SkateGeo.getUserLocation()) { if (S.radiusWanted) { S.radius = S.radiusWanted; S.radiusWanted = null; SkateSettings.set('radius', S.radius); } }
        else if (S.radius) { S.radius = null; SkateSettings.set('radius', null); }
        SkateWeather.load(true);
        Render.rinks();
        SkateMap.refresh();
        Actions.applyFilters(true);
    }

    Actions.useMyLocation = async function () {
        const btn = $('btn-share-location');
        btn.disabled = true; btn.textContent = 'Locating…';
        try {
            const loc = await SkateGeo.locateMe();
            SkateGeo.setUserLocation(loc);
            locationChanged();
        } catch (e) {
            $('locator-status').textContent = e.message;
        }
        btn.disabled = false; btn.textContent = 'Near me';
    };

    /** Forget the saved location: distances, Nearest order and the weather spot fall back. */
    Actions.clearLocation = function () {
        SkateGeo.setUserLocation(null);
        S.sort = S.sort === 'near' ? 'time' : S.sort;
        persistFilters();
        locationChanged();
        $('locator-status').textContent = 'Location cleared. Distances are off until you set one again.';
    };

    /* ---------- Add to Home Screen (phones) ---------- */
    const isMobileBrowser = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
    let deferredInstall = null;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

    /** One-time card above the list on phones (browser, not the installed app). */
    // v3.16.4: no install card in the list any more (on a phone it pushed the first sessions off the screen);
    // Settings keeps "Add to Home Screen" (Actions.openInstall)
    Render.installHint = function () {
        const box = $('install-hint');
        if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    };

    Actions.openInstall = function () {
        SkateSettings.set('installSeen', true);
        Render.installHint();
        const body = $('install-body');
        if (isStandalone()) {
            body.innerHTML = '<p>You are already using the installed app.</p>';
        } else if (isIOS()) {
            body.innerHTML = `<ol class="install-steps"><li>Tap the <strong>Share</strong> button in Safari (the square with an arrow, bottom of the screen).</li><li>Scroll and choose <strong>Add to Home Screen</strong>.</li><li>Tap <strong>Add</strong>.</li></ol>
                <p class="settings-hint">Added it a while ago and the top of the app looks blurred? Remove the icon and add it again: iOS reads the app's settings only when the icon is created.</p>`;
        } else if (deferredInstall) {
            body.innerHTML = '<p>Your browser can install it directly.</p><button class="btn-primary" id="btn-install-now">Install</button>';
            $('btn-install-now').onclick = async () => { const ev = deferredInstall; deferredInstall = null; try { await ev.prompt(); } catch {} Modal.close('install-modal'); };
        } else if (isMobileBrowser()) {
            body.innerHTML = '<ol class="install-steps"><li>Open the browser menu (the three dots).</li><li>Choose <strong>Add to Home screen</strong> or <strong>Install app</strong>.</li><li>Confirm.</li></ol>';
        } else {
            body.innerHTML = '<p>On your phone, open this site in Safari or Chrome and choose <strong>Add to Home Screen</strong>. The QR code in Settings gets you there.</p>';
        }
        Modal.close('settings-modal');
        Modal.open('install-modal');
    };

    /** Measure distances from what is typed in the rink search (an address, a postal code, a neighbourhood). */
    Actions.searchLocation = async function () {
        const btn = $('btn-locator-search');
        const text = $('rinks-search').value.trim();
        if (!text) return;
        btn.disabled = true;
        $('locator-status').textContent = 'Searching…';
        try {
            const loc = await SkateGeo.geocode(text);
            SkateGeo.setUserLocation(loc);
            // the text was a place, not a rink filter: show every rink again, nearest first
            $('rinks-search').value = '';
            syncRinkSearch();
            locationChanged();
        } catch (e) {
            $('locator-status').textContent = e.message;
        }
        btn.disabled = false;
    };

    Actions.filterToRink = function (key, name) {
        S.nearRink = { key, name };
        // widen anything that would hide this rink's sessions
        if (S.rinkScope === 'mine' && !(SkateSettings.get('myRinks') || []).includes(key)) S.rinkScope = 'all';
        const rink = SkateGeo.rinkByLocation(key);
        if (rink && rink.paid) { S.paidVisible = true; SkateSettings.set('freeOnly', false); }
        ensurePaidVisibleFor(key, name);
        SkateMap.close();
        Actions.applyFilters();
        SkateUI.toast(`Showing only ${name}. Tap the pill's x to clear.`, 'info', 3500);
    };

    /* ---------- Section visibility + first-visit setup ---------- */
    let chatBooted = false;   // guards the badge refresh before SkateChat.init()

    /* ---------- The community code (v3.8: loaded only when wanted) ----------
     * nostr.bundle.js alone is 250 KB; with the chat, guides, moderation and
     * dev-chat modules the stack is ~360 KB that a schedule-only visit never
     * needs. The scripts are injected on demand (fetched in parallel, run in
     * order), the service worker keeps every versioned file cache-first, so
     * the first enable downloads once and every later load is instant and
     * always the version index.html names. */
    const COMMUNITY_SCRIPTS = [
        '../assets/js/nostr.bundle.js?v=1',
        'projects/js/moderation.js?v=7',
        'projects/js/nostr-core.js?v=5',
        'projects/js/chat-v2.js?v=19',
        'projects/js/devchat.js?v=9',
        'projects/js/guides.js?v=6',
        'projects/js/profanity-list.js?v=1'
    ];
    const loadedScripts = new Map();   // src -> promise: two callers asking at once share one <script>, a failure can be retried
    function loadScript(src) {
        let p = loadedScripts.get(src);
        if (p) return p;
        p = new Promise((resolve, reject) => {
            const tag = document.createElement('script');
            tag.src = src;
            tag.async = false;   // dynamic scripts with async=false run in insertion order
            tag.dataset.lazy = '1';   // v3.12.2: loaded by the app, not by index.html: not part of the release identity
            tag.onload = () => resolve();
            tag.onerror = () => { tag.remove(); loadedScripts.delete(src); reject(new Error(`could not load ${src.split('/').pop().split('?')[0]}`)); };
            document.head.appendChild(tag);
        });
        loadedScripts.set(src, p);
        return p;
    }
    const communityLoaded = () => !!(window.NostrTools && window.SkateMod && window.SkateNostr && window.SkateChat && window.SkateGuides && window.SkateDev);   // each module attaches itself to window
    let communityCodePromise = null;
    function loadCommunityCode() {
        if (communityLoaded()) return Promise.resolve();
        if (communityCodePromise) return communityCodePromise;
        S.communityState = 'loading';
        Render.chatLoading();
        communityCodePromise = Promise.all(COMMUNITY_SCRIPTS.map(src =>
            loadScript(src).catch(e => { if (/profanity/.test(src)) return; throw e; })   // the word list degrades gracefully
        )).then(() => {
            if (!communityLoaded()) throw new Error('community modules missing after load');
            S.communityState = 'ready';
            SkateDev.bind();
        }).catch(e => {
            communityCodePromise = null;
            S.communityState = 'failed';
            S.communityError = e.message;
            Render.chatLoading();
            throw e;
        });
        return communityCodePromise;
    }
    /** Just the signing library (the City-refresh doorbell signs a throwaway note). */
    const ensureNostrTools = () => window.NostrTools ? Promise.resolve() : loadScript(COMMUNITY_SCRIPTS[0]);

    /* ---------- Members' entrance (v3.11) ----------
     * projects/js/gate.js is fetched only for the #hq link, or on a device that
     * has been let in before. An ordinary visit never downloads it and never
     * contacts the members' server. */
    const GATE_SCRIPT = 'projects/js/gate.js?v=4';
    /** Let in before, with the key now on this device? Reads two localStorage entries, nothing else. */
    function gateKnown() {
        try {
            const id = JSON.parse(localStorage.getItem('skate_identity_v1') || 'null');
            if (!id || !id.pk) return false;
            // the site owner's own key(s): always, on any device that holds one
            const admins = (CFG.gate && Array.isArray(CFG.gate.admins) && CFG.gate.admins.length) ? CFG.gate.admins : [CFG.devPubkey];
            if (admins.includes(id.pk)) return true;
            const st = JSON.parse(localStorage.getItem('skate_gate_v1') || 'null');
            return !!(st && ((st.members && st.members[id.pk]) || st.invited === id.pk));
        } catch { return false; }
    }
    Actions.openGate = async function (opts) {
        const quiet = !!(opts && opts.quiet);
        try { await ensureNostrTools(); await loadScript(GATE_SCRIPT); }
        catch { if (!quiet) SkateUI.toast('Could not load that part of the site. Try again online.', 'error', 3500); return; }
        return window.SkateGate.open({ quiet });
    };

    /** Loading / failed / connecting placeholder in the Chats list until the stack is up. */
    Render.chatLoading = function () {
        if (chatBooted) return;
        const list = $('conversation-list');
        if (!list) return;
        list.innerHTML = '';
        const li = el('li', { class: 'conv-empty community-loading' });
        if (S.communityState === 'failed') {
            li.append(
                el('p', {}, [`Chat could not load${S.communityError ? ` (${S.communityError})` : ''}. Check your connection.`]),
                el('button', { class: 'btn-primary btn-small', onclick: () => Actions.bootCommunity().catch(() => {}) }, ['Try again'])
            );
        } else {
            li.append(el('p', {}, [S.communityState === 'loading' ? 'Loading chat… the first time takes a moment; after that it is instant.' : 'Connecting…']));
        }
        list.appendChild(li);
    };

    /**
     * Boot the community stack (code → relays → chat → guides) once, and only
     * when a community section is on (or a deep link asks for it). A
     * schedule-only visit downloads none of it and opens zero websockets.
     */
    let communityBootPromise = null, guidesHooked = false;
    const chatsViewOnScreen = () => S.chatOpen && document.querySelector('.view-panel.active')?.id === 'chats-panel';
    Actions.bootCommunity = function () {
        if (communityBootPromise) return communityBootPromise;
        communityBootPromise = (async () => {
            try {
                await loadCommunityCode();
                SkateMod.resetLocal();     // un-latch, in case anything checked before the word list arrived
                await SkateChat.init();    // identity, state, relays, subscriptions
                chatBooted = true;
                SkateChat.setViewOpen(chatsViewOnScreen());
                SkateChat.onUpdate(Render.chatUI);
                if (!netbarHooked) { netbarHooked = true; SkateNostr.onStatus(st => Render.netbar(st.connected)); }
                SkateDev.attach();
                if (SkateSettings.get('showGuides') !== false) {
                    SkateGuides.load();
                    if (!guidesHooked) { guidesHooked = true; SkateGuides.onUpdate(scheduleGuidesRender); }
                }
                Render.chatUI(SkateChat.getState());
            } catch (e) {
                communityBootPromise = null;
                console.warn('[community] boot failed:', e.message);
                Render.chatLoading();
                throw e;
            }
        })();
        return communityBootPromise;
    };

    /** Offline banner in the conversation view: no relay reachable right now. */
    let netbarHooked = false;
    Render.netbar = function (connected) {
        const bar = $('chat-netbar');
        if (bar) bar.classList.toggle('hidden', !(chatBooted && connected === 0));
    };

    /** A notification or deep link lands in a conversation: section on, Chats view, thread open. */
    Actions.jumpToConversation = async function (kind, id) {
        Actions.ensureSectionVisible('showChats');
        try { await Actions.bootCommunity(); } catch { return; }
        Actions.switchView('chats');
        Actions.openConversation(kind, id);
    };

    /** Settings → Notify: ask the browser once; iPhones cannot do this for a website. */
    Actions.enableNotifications = async function () {
        if (typeof Notification === 'undefined') {
            SkateSettings.set('notifyDesktop', false);
            SkateUI.toast('This browser cannot show notifications for a website (iPhone Safari only allows them for installed apps with push, which this site does not use).', 'info', 6000);
            Render.settings();
            return;
        }
        let perm = Notification.permission;
        if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; } }
        if (perm !== 'granted') {
            SkateSettings.set('notifyDesktop', false);
            SkateUI.toast('Notifications are blocked for this site. Allow them in the browser\'s site settings, then switch Notify on again.', 'error', 5000);
        } else {
            SkateUI.toast('You will be notified of DMs and @mentions while this tab is in the background.', 'success', 4000);
        }
        Render.settings();
    };

    /** Both sections off (and nothing else needs the relays): goodbye, sockets closed, badge cleared. */
    Actions.shutdownCommunity = function () {
        if (!chatBooted) { communityBootPromise = null; return; }
        try { SkateGuides.stop(); } catch {}
        try { SkateChat.shutdown(); } catch {}
        chatBooted = false;
        communityBootPromise = null;
        S.communityState = 'ready';
        $('chats-badge').classList.add('hidden');
        Render.netbar(1);
        Render.chatLoading();
    };

    /** First visit not yet handled? (Existing users are grandfathered.) */
    const setupPending = () =>
        !SkateSettings.get('setupDone') && !SkateSettings.get('experience') && !SkateSettings.get('displayName');

    /**
     * Community boots only when a section is on AND the visitor has had
     * their say. Deep links that need chat call bootCommunity() directly.
     */
    const communityWanted = () =>
        !setupPending() &&
        (SkateSettings.get('showGuides') !== false || SkateSettings.get('showChats') !== false);

    Actions.applyVisibility = function () {
        const guidesOn = SkateSettings.get('showGuides') !== false;
        document.body.classList.toggle('hide-guides', !guidesOn);
        document.body.classList.toggle('hide-chats', SkateSettings.get('showChats') === false);
        Render.tabs();
        if (chatBooted) {
            Render.chatUI(SkateChat.getState());   // repopulate the rebuilt badge
            // guides follow their own switch while the stack is up
            if (guidesOn) { SkateGuides.load(); if (!guidesHooked) { guidesHooked = true; SkateGuides.onUpdate(scheduleGuidesRender); } }
            else SkateGuides.stop();
            SkateChat.setViewOpen(chatsViewOnScreen());
        }
        if (communityWanted()) Actions.bootCommunity().catch(() => {});   // late enable → load + boot now
        else Actions.shutdownCommunity();                                 // both off → silence
        // never leave the user staring at a hidden panel
        const active = document.querySelector('.view-panel.active');
        if (active && ((active.id === 'guides-panel' && SkateSettings.get('showGuides') === false) ||
                       (active.id === 'chats-panel' && SkateSettings.get('showChats') === false))) {
            Actions.switchView('programs');
        }
    };

    /** Deep links (shared guides, group invites, DMs) re-enable a hidden
     *  section — following a link is an explicit request to see it. */
    Actions.ensureSectionVisible = function (visKey) {
        if (SkateSettings.get(visKey) === false) {
            SkateSettings.set(visKey, true);
            Actions.applyVisibility();
            SkateUI.toast(`${visKey === 'showGuides' ? 'Guides' : 'Chats'} switched on. Hide it again in Settings.`, 'info', 3500);
        }
    };

    /**
     * First visit, v3.4: no welcome form. The visitor lands on Toronto
     * leisure and figure skating (the two kinds most people mean by "public
     * skating"), community sections stay off until chosen in Settings, and
     * the spotlight tour starts after the first render with Skip up front.
     * Returns true on a brand-new install.
     */
    /** ♡ from a row or a calendar block; the first save retires the heart nudge. */
    Actions.toggleSaved = function (p) {
        if (SkateFavorites.toggle(p)) SkateSettings.set('heartHintDone', true);
        Render.programs();
    };

    Actions.firstRun = function () {
        if (SkateSettings.get('setupDone')) return false;
        if (SkateSettings.get('experience') || SkateSettings.get('displayName')) {
            SkateSettings.set('setupDone', true);   // existing user: nothing changes
            return false;
        }
        SkateSettings.set('showGuides', false);
        SkateSettings.set('showChats', false);
        S.cities = ['Toronto'];
        S.types = { leisure: 'all', figure: 'all', other: 'all', adapted: 'all', ringette: 'all', speed: 'all' };
        persistFilters();
        SkateSettings.set('setupDone', true);
        return true;
    };

    /* ---------- What's new ---------- */
    /* ---------- QR share (vendored generator, lazy-injected) ---------- */
    let qrLibReady = null;
    Actions.openQr = async function () {
        Modal.open('qr-modal');
        $('qr-url').textContent = CFG.siteUrl;
        if (!qrLibReady) {
            qrLibReady = new Promise((resolve, reject) => {
                const s = el('script', { src: 'assets/vendor/qrcode.js' });
                s.onload = resolve;
                s.onerror = () => reject(new Error('QR generator failed to load'));
                document.head.appendChild(s);
            }).catch(e => { qrLibReady = null; throw e; });
        }
        try {
            await qrLibReady;
            const qr = window.qrcode(0, 'M');
            qr.addData(CFG.siteUrl);
            qr.make();
            // generous white quiet zone so it scans off dark-mode screens
            $('qr-holder').innerHTML = qr.createImgTag(6, 12);
        } catch (e) {
            $('qr-holder').innerHTML = '<p class="settings-hint">Could not build the QR code. The Copy link button still works.</p>';
        }
    };

    /** How the pipeline read the alerts on file, for the freshness menu (v3.10). */
    function alertReaderLine(r) {
        const counts = `${r.read} read for meaning, ${r.rules} plain status notices${r.waiting ? `, ${r.waiting} waiting` : ''}`;
        return r.error ? `Alert reading: reader offline (${r.error}), word rules cover the gap · ${counts}`
            : `Alert reading: ${r.by} · ${counts}`;
    }

    /** Popup body for a rink pin (SkateMap calls this per open). */
    function mapPopupHtml(r) {
        const key = String(r.locationid);
        const user = SkateGeo.getUserLocation();
        const km = user && r.lat != null ? SkateGeo.distanceKm(user, { lat: r.lat, lng: r.lng }) : null;
        const sp = upcomingSplit(key);
        const sessions = S.paidVisible ? sp.free + sp.paid : sp.free;
        const alerts = SkateAlerts.forLocation(key);
        const mine = (SkateSettings.get('myRinks') || []).includes(key);
        const kinds = (r.kinds || []).map(k => k === 'indoor' ? 'indoor' : 'outdoor').join(' · ');
        const city = rinkCity(r);
        const offR = officialUrlForRink(r);
        const sessionsTxt = sessions ? `${sessions} upcoming session${sessions === 1 ? '' : 's'}`
            : (sp.paid ? `${sp.paid} paid session${sp.paid === 1 ? '' : 's'} (Paid toggle off)` : 'no drop-ins listed');
        return `<div class="map-pop">
            <strong>${escapeHtml(r.name)}</strong>
            <span class="map-pop-meta">${city !== 'Toronto' ? escapeHtml(city) + ' · ' : ''}${kinds}${r.paid ? ' · paid' : ''}${km != null ? ` · ${SkateGeo.fmtKm(km)}` : ''}${offR ? ` · <a href="${escapeHtml(offR)}" target="_blank" rel="noopener">official page ↗</a>` : ''}</span>
            <span class="map-pop-meta">${sessionsTxt}${alerts.length ? ' · <span class="map-pop-alert">service alert</span>' : ''}</span>
            <span class="map-pop-actions">
                ${(sessions || sp.paid) ? `<button class="btn-small" data-map-sessions="${escapeHtml(key)}" data-map-name="${escapeHtml(r.name)}">Show sessions</button>` : ''}
                <button class="btn-small${mine ? ' starred' : ''}" data-map-star="${escapeHtml(key)}">${mine ? '★ One of my rinks' : '☆ Add to my rinks'}</button>
            </span>
        </div>`;
    }

    /* ---------- Free skates page (v3.11) ---------- */
    const LEND_DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    Render.lending = function () {
        const box = $('lending-body'), L = S.lending, today = SkateTime.todayKey();
        if (!L || !L.van) { box.innerHTML = '<p class="settings-hint">This could not be loaded right now. Try again in a moment.</p>'; return; }
        const v = L.van, link = (url, text) => httpOnly(url) ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${text} ↗</a>` : '';
        const upcoming = (lendIx ? lendIx.stops : []).filter(s => s.date >= today).slice(0, 40);
        let html = `<p class="lend-lead"><strong>${escapeHtml(v.name || 'Skate Lending Library')}</strong> · ${escapeHtml(v.by || '')}. A van brings free ${escapeHtml(v.lends || 'skates')} to one rink a day. ${escapeHtml(v.terms || '')}</p>`;
        if (upcoming.length) {
            html += '<ul class="lend-list">' + upcoming.map(s => `<li${s.date === today ? ' class="today"' : ''}><span class="lend-when">${s.date === today ? 'Today' : escapeHtml(lendDate(s.date))} · ${escapeHtml(lendHours(s.from, s.to))}</span><span class="lend-where">${escapeHtml(s.place || '')}${s.address ? `<em>${escapeHtml(s.address)}</em>` : ''}${s.note ? `<em>${escapeHtml(s.note)}</em>` : ''}</span></li>`).join('') + '</ul>';
        } else if (v.status === 'soon' || (v.startsOn && v.startsOn > today)) {
            html += `<p class="lend-note">${v.startsOn ? `The van starts on ${escapeHtml(lendDate(v.startsOn))}. ` : ''}The City has not posted this winter's stops yet. They will appear here, and on the sessions at each rink, as soon as it does.</p>`;
        } else {
            html += '<p class="lend-note">No upcoming stops are posted right now.</p>';
        }
        html += `<p class="lend-source">${link(v.url, 'The City\'s schedule page')}</p>`;
        const also = (lendIx ? lendIx.also : []).filter(a => a.end >= today);
        if (also.length) {
            html += '<h4>Also free</h4><ul class="lend-list also">' + also.map((a) => {
                const hours = a.from && a.to ? ` ${lendHours(a.from, a.to)}` : '';
                const when = a.date ? `${lendDate(a.date)}${hours ? ' ·' + hours : ''}`
                    : a.days ? `${a.days.map(d => LEND_DAYS[d]).join(', ')}${hours}, ${a.start > today ? `${lendShort(a.start)} to ${lendShort(a.end)}` : `until ${lendShort(a.end)}`}`
                    : 'All season';
                const shut = a.rink ? seasonWord(SkateGeo.rinkByLocation(a.rink)) : '';   // v3.12
                return `<li><span class="lend-where">${escapeHtml(a.place)}${a.address ? `<em>${escapeHtml(a.address)}</em>` : ''}</span><span class="lend-what">${escapeHtml(a.what || '')}. <span class="lend-when">${escapeHtml(when)}.</span>${shut ? ` <strong class="lend-shut">The rink: ${escapeHtml(shut.toLowerCase())}.</strong>` : ''} ${link(a.url, 'Details')}</span></li>`;
            }).join('') + '</ul>';
        }
        const checked = L.checkedAt ? new Date(L.checkedAt) : null;
        html += `<p class="settings-hint">Stops move with the weather and the ice: check the linked page before you go.${checked && !isNaN(checked) ? ` Last checked ${escapeHtml(checked.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }))}.` : ''}</p>`;
        box.innerHTML = html;
    };
    Actions.openLending = async function () {
        if (!S.lending) { try { setLending(await SkateAPI.getLending()); } catch {} }
        Render.lending();
        Modal.open('lending-modal');
    };

    /* ---------- Natural ice (v3.12) ----------
     * natural-ice.json: the parks the City approved for rinks that neighbours
     * flood and shovel themselves. A plain list, nearest first when a spot is
     * set. No hours and no open or closed: nobody reports either, and a status
     * nobody keeps would be wrong most days. */
    Render.natural = function (data) {
        const box = $('natural-body');
        const num = (x) => typeof x === 'number' && Number.isFinite(x);
        const ok = (p) => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim() && /^\d{1,6}$/.test(String(p.id ?? ''));
        const parks = data && Array.isArray(data.parks) ? data.parks.filter(ok).slice(0, 400) : [];
        if (!parks.length) { box.innerHTML = '<p class="settings-hint">This could not be loaded right now. Try again in a moment.</p>'; return; }
        const user = SkateGeo.getUserLocation();
        const rows = parks.map(p => ({ id: String(p.id), name: p.name, address: typeof p.address === 'string' ? p.address : '',
            km: user && num(p.lat) && num(p.lng) ? SkateGeo.distanceKm(user, { lat: p.lat, lng: p.lng }) : null }));
        rows.sort((a, b) => ((a.km ?? Infinity) - (b.km ?? Infinity)) || a.name.localeCompare(b.name));
        const season = typeof data.season === 'string' && /^\d{4}\/\d{4}$/.test(data.season) ? data.season : '';
        let html = `<p class="lend-lead"><strong>${rows.length} parks</strong> where neighbours flood and shovel a rink when it stays cold. The City approves the spot and lends the hoses; volunteers do the rest. No staff, no boards, no change room.</p>`;
        html += '<p class="lend-note">Nobody reports whether there is ice, so this list has no hours and no open or closed. The City\'s guide says a rink needs about five days at −4 °C or colder and then a week of flooding, and a thaw undoes it. Go by the weather, and look before you lace up.</p>';
        if (season && data.current === false) html += `<p class="lend-note nat-last"><strong>This is last winter's list (${escapeHtml(season)}).</strong> ${typeof data.next === 'string' && data.next ? escapeHtml(data.next.slice(0, 200)) + ' ' : ''}The new list replaces this one here by itself.</p>`;
        else if (season) html += `<p class="lend-note">Approved by the City for ${escapeHtml(season)}.</p>`;
        html += `<p class="settings-hint">${user ? `Nearest to ${escapeHtml(user.label || 'your spot')} first.` : 'In A to Z order. Set a spot under Rinks and map to see the nearest first.'}</p>`;
        html += '<ul class="lend-list nat-list">' + rows.map(p => `<li><span class="lend-where">${escapeHtml(p.name)}<em>${escapeHtml(p.address)}${p.km != null ? `${p.address ? ' · ' : ''}${SkateGeo.fmtKm(p.km)}` : ''}</em></span>` +
            `<span class="nat-links"><a href="${mapsUrl(`${p.name}${p.address ? ', ' + p.address : ''}`, 'Toronto')}" target="_blank" rel="noopener">Map ↗</a>` +
            `<a href="${TORONTO_LOC_URL}${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Park page ↗</a></span></li>`).join('') + '</ul>';
        const checked = data.checkedAt ? new Date(data.checkedAt) : null;
        html += `<p class="lend-source">${httpOnly(data.url) ? `<a href="${escapeHtml(data.url)}" target="_blank" rel="noopener">The City's natural ice rinks page ↗</a>` : ''}${checked && !isNaN(checked) ? ` Read ${escapeHtml(checked.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }))}.` : ''}</p>`;
        box.innerHTML = html;
    };
    Actions.openNatural = async function () {
        $('natural-body').innerHTML = '<p class="settings-hint">Loading…</p>';
        Modal.open('natural-modal');
        let data = null;
        try { data = await SkateAPI.getNaturalIce(); } catch { /* the sheet says so */ }
        Render.natural(data);
    };

    Actions.openWhatsNew = function () {
        Render.whatsNew();
        SkateSettings.set('lastSeenVersion', CFG.version);
        $('settings-dot').classList.add('hidden');
        Modal.open('whatsnew-modal');
    };

    Actions.openGuide = async function (id) {
        Actions.ensureSectionVisible('showGuides');
        Actions.switchView('guides');
        try { await Actions.bootCommunity(); } catch { return; }
        const g = SkateGuides.get(id);
        if (!g) {
            S.pendingGuideOpen = id;
            if (SkateGuides.loaded) SkateUI.toast('That guide is not on the relays yet', 'info', 3000);
            return;
        }
        S.pendingGuideOpen = null;
        S.activeGuideId = id;
        Actions.clearGuideReply();
        $('guides-home').classList.add('hidden');
        $('guide-write').classList.add('hidden');
        $('guide-detail').classList.remove('hidden');
        Render.guideDetail();
    };

    Actions.closeGuide = function () {
        S.activeGuideId = null;
        Actions.clearGuideReply();
        $('guide-detail').classList.add('hidden');
        $('guides-home').classList.remove('hidden');
        Render.guides();
    };

    Actions.toggleGuideVote = async function (targetId, btn) {
        btn.disabled = true;
        try {
            const ok = await SkateGuides.vote(targetId, identity());
            if (!ok) SkateUI.toast('The vote did not reach the relays. Try again.', 'error');
        } catch (e) { SkateUI.toast(e.message, 'error'); }
        btn.disabled = false;
        Render.guides();
    };

    Actions.setGuideReply = function (id, name) {
        S.guideReply = { id, name };
        $('guide-reply-label').textContent = `↩ Replying to ${name}`;
        $('guide-reply-bar').classList.remove('hidden');
        $('guide-comment-input').focus();
    };
    Actions.clearGuideReply = function () {
        S.guideReply = null;
        $('guide-reply-bar').classList.add('hidden');
    };

    Actions.submitGuideComment = async function () {
        const text = $('guide-comment-input').value;
        if (!text.trim() || !S.activeGuideId) return;
        const btn = $('btn-guide-comment');
        btn.disabled = true; btn.textContent = '…';
        try {
            const ok = await SkateGuides.comment(S.activeGuideId, text, identity(), S.guideReply?.id || null);
            if (ok) { $('guide-comment-input').value = ''; Actions.clearGuideReply(); Render.guideDetail(); }
            else SkateUI.toast('The comment did not reach the relays', 'error');
        } catch (e) { SkateUI.toast(e.message, 'error'); }
        btn.disabled = false; btn.textContent = '➤';
    };

    Actions.submitGuide = async function () {
        const btn = $('btn-guide-submit');
        btn.disabled = true; btn.textContent = 'Proving you are human…';
        try {
            const ok = await SkateGuides.postGuide({
                title: $('guide-title-input').value,
                category: $('guide-cat-input').value,
                body: $('guide-body-input').value
            }, identity());
            if (ok) {
                SkateUI.toast('Guide published', 'success');
                $('guide-title-input').value = ''; $('guide-body-input').value = '';
                $('guide-write').classList.add('hidden');
                $('guides-home').classList.remove('hidden');
                Render.guides();
            } else SkateUI.toast('The relays did not accept it. Try again.', 'error');
        } catch (e) { SkateUI.toast(e.message, 'error'); }
        btn.disabled = false; btn.textContent = 'Publish guide';
    };

    Actions.shareGuideFromDetail = function (g) {
        // If the reader highlighted a passage inside the guide body, quote it
        let excerpt = '';
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount) {
            const body = $('guide-body-text');
            if (body && body.contains(sel.getRangeAt(0).commonAncestorContainer)) {
                excerpt = sel.toString().trim().slice(0, 200);
            }
        }
        if (!excerpt) excerpt = g.body.slice(0, 140).trim();
        Actions.openSharePicker({ type: 'guide', payload: { guideId: g.id, title: g.title, category: g.category, excerpt } });
    };

    /* ---------- Chats ---------- */
    Actions.focusChatInput = () => setTimeout(() => $('chat-input').focus(), 60);

    Actions.openConversation = function (kind, id) {
        S.chatOpen = true;
        Actions.clearReply();
        SkateChat.openConversation(kind, id);
        SkateChat.setViewOpen(chatsViewOnScreen());
        Actions.focusChatInput();
    };

    Actions.startDm = async function (pubkey, name) {
        await Actions.bootCommunity();
        if (SkateChat.startDm(pubkey, name)) {
            Actions.ensureSectionVisible('showChats');
            S.chatOpen = true;
            Actions.switchView('chats');
            Actions.focusChatInput();
        }
    };

    Actions.backToList = function () {
        const s = SkateChat.getState();
        if (s.viewMode === 'dm') SkateChat.closeDm();
        S.chatOpen = false;
        SkateChat.setViewOpen(false);
        S.lastRenderedConv = null;
        Actions.clearReply();
        Render.chatUI(SkateChat.getState());
    };

    Actions.setReply = function (m) {
        S.replyTo = { id: m.id, from: m.from || 'Skater', text: (m.text || m.data?.title || m.data?.activity || '').slice(0, 120) };
        $('chat-reply-label').textContent = `↩ Replying to ${S.replyTo.from}: ${S.replyTo.text.slice(0, 60)}`;
        $('chat-reply-bar').classList.remove('hidden');
        Actions.focusChatInput();
    };
    Actions.clearReply = function () {
        S.replyTo = null;
        $('chat-reply-bar').classList.add('hidden');
    };

    Actions.sendCurrent = async function () {
        const input = $('chat-input');
        const text = input.value;
        if (!text.trim()) return;
        input.value = '';
        input.style.height = '';
        const reply = S.replyTo;
        Actions.clearReply();
        const s = SkateChat.getState();
        if (s.viewMode === 'dm') await SkateChat.sendDm(text, reply);
        else await SkateChat.sendMessage(text, reply);
    };

    function findMessage(chatState, mid) {
        const pool = chatState.viewMode === 'dm'
            ? chatState.activeDmThread?.messages
            : chatState.activeGroup?.messages;
        return (pool || []).find(m => m.id === mid || m.localId === mid) || null;
    }

    Actions.scrollToMsg = function (mid) {
        const node = document.querySelector(`.chat-msg[data-mid="${CSS.escape(mid)}"]`);
        if (!node) return SkateUI.toast('That message isn\'t loaded anymore', 'info', 2000);
        flash(node);
    };

    /* ---------- Share picker ---------- */
    Actions.openSharePicker = async function (ctx) {
        try { await Actions.bootCommunity(); } catch { return; }
        S.shareCtx = ctx;
        Render.sharePicker(ctx);
        Modal.open('share-modal');
    };
    Actions.doShare = async function (dest) {
        const ctx = S.shareCtx;
        if (!ctx) return;
        Modal.close('share-modal');
        S.shareCtx = null;
        if (ctx.type === 'program') await SkateChat.shareProgram(ctx.payload, dest);
        else await SkateChat.shareGuide(ctx.payload, dest);
    };

    /* ---------- Invites + router ---------- */
    let lastRoutedHash = null;
    Actions.route = async function () {
        const hash = window.location.hash.slice(1);
        if (!hash || hash === lastRoutedHash) return;
        lastRoutedHash = hash;
        if (hash === 'hq') { Actions.openGate(); return; }
        // an invite link needs the chat code to be parsed (and then joined)
        if (/^(i=|j=)/.test(hash) || /^[0-9a-f]{32,}$/i.test(hash)) {
            try { await loadCommunityCode(); } catch { SkateUI.toast('Could not load the chat code for this invite. Try again online.', 'error', 4000); return; }
        }
        for (const r of CFG.routes) {
            if (r.prefix && hash.startsWith(r.prefix)) {
                const arg = hash.slice(r.prefix.length);
                if (r.action === 'focusProgram') {
                    Actions.switchView('programs');
                    if (S.programs.length) Actions.focusProgram(arg);
                    else S.pendingProgramFocus = arg;
                } else if (r.action === 'openGuide') {
                    Actions.openGuide(arg);
                }
                return;
            }
        }
        const invite = SkateChat.parseInviteHash(hash);
        if (invite) Actions.showInvite(invite);
    };

    Actions.clearHash = function () {
        lastRoutedHash = null;
        history.replaceState(null, '', baseUrl());
    };

    Actions.showInvite = function (invite) {
        S.pendingInvite = invite;
        $('invite-name').textContent = invite.name || 'Skating Group';
        $('invite-error').textContent = '';
        $('invite-pw-input').value = '';
        $('invite-pw-field').classList.toggle('hidden', invite.mode !== 'password');
        Modal.open('invite-modal');
        if (invite.mode === 'password') setTimeout(() => $('invite-pw-input').focus(), 60);
    };

    Actions.confirmInvite = async function () {
        const inv = S.pendingInvite;
        if (!inv) return;
        const btn = $('btn-invite-join');
        btn.disabled = true;
        try {
            // invite link on a chats-hidden install: make chats visible and
            // wait for the community stack before joining
            Actions.ensureSectionVisible('showChats');
            await Actions.bootCommunity();
            await SkateChat.acceptInvite(inv, $('invite-pw-input').value || null);
            S.pendingInvite = null;
            Modal.close('invite-modal');
            Actions.clearHash();
            Actions.ensureSectionVisible('showChats');
            S.chatOpen = true;
            Actions.switchView('chats');
            Actions.focusChatInput();
        } catch (e) {
            $('invite-error').textContent = e.message || 'Could not join';
        }
        btn.disabled = false;
    };

    Actions.dismissInvite = function () {
        S.pendingInvite = null;
        Modal.close('invite-modal');
        Actions.clearHash();
    };

    Actions.openSettings = function () {
        $('settings-name').value = (window.SkateChat && SkateChat.getState().myName) || SkateSettings.get('displayName') || '';
        $('btn-play-guide').textContent = `Watch the ${SkateTour.duration()}-second guide`;
        Render.settings();
        Render.identityLine();
        Modal.open('settings-modal');
    };

    /* ---------- Pull-to-refresh (the installed app has no browser reload) ----------
       Touch-only. Pull the schedule panel down while it sits at the top:
       an indicator grows, arms at THRESHOLD, and releasing runs the same
       full reload as the Refresh button (schedule + alerts + live check +
       spots). Passive listeners — nothing here can jank scrolling. */
    function initPullToRefresh() {
        const panel = $('programs-panel'), ind = $('ptr');
        if (!panel || !ind || !('ontouchstart' in window)) return;
        const THRESHOLD = 68;
        const text = ind.querySelector('.ptr-text');
        let startY = null, pulling = false, armed = false, busy = false;
        const setPull = (px) => { ind.style.height = `${px}px`; ind.classList.toggle('visible', px > 0); };
        // A touch that starts on a control is a tap, never a pull: growing the
        // indicator on finger jitter shifted the whole column under the finger,
        // and Android then clicked whatever had slid under it (v3.9).
        const SLOP = 14;
        panel.addEventListener('touchstart', (e) => {
            if (busy || panel.scrollTop > 0 || Modal.any() || SkateTour.running || e.target.closest('button, a, input, label, select, textarea, [role="button"], .pill, .fchip')) { startY = null; return; }
            startY = e.touches[0].clientY; pulling = false; armed = false;
        }, { passive: true });
        panel.addEventListener('touchmove', (e) => {
            if (startY === null || busy) return;
            const dy = e.touches[0].clientY - startY;
            if (dy <= SLOP || panel.scrollTop > 0) { if (pulling) { pulling = false; armed = false; setPull(0); } return; }
            pulling = true;
            const px = Math.min(104, (dy - SLOP) * 0.45);
            setPull(px);
            armed = px >= THRESHOLD;
            text.textContent = armed ? 'Release to refresh' : 'Pull to refresh';
            ind.classList.toggle('armed', armed);
        }, { passive: true });
        const end = async () => {
            if (startY === null) return;
            startY = null;
            if (!pulling) return;
            pulling = false;
            if (!armed) { setPull(0); return; }
            armed = false; busy = true;
            ind.classList.add('busy'); text.textContent = 'Refreshing…'; setPull(52);
            try {
                await Actions.reloadData();
                SkateUI.toast('Schedule, alerts and spots refreshed', 'success', 2000);
            } catch (e) {
                SkateUI.toast('Refresh failed: ' + e.message, 'error');
            } finally {
                busy = false;
                ind.classList.remove('busy', 'armed');
                setPull(0);
            }
        };
        panel.addEventListener('touchend', end, { passive: true });
        panel.addEventListener('touchcancel', end, { passive: true });
    }

    /* ---------- Appearance (Settings → Auto / Light / Dark) ---------- */
    const systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    /**
     * Current theme setting — DEFAULTS TO AUTO (follow the device) now
     * that dark earned its keep. Pre-2.3 `darkMode` key migrates once.
     */
    function themeSetting() {
        let t = SkateSettings.get('theme');
        if (!t) {
            t = localStorage.getItem('darkMode') === 'true' ? 'dark' : 'system';
            SkateSettings.set('theme', t);
        }
        return t;
    }

    Actions.applyTheme = function () {
        const t = themeSetting();
        const dark = t === 'dark' || (t === 'system' && !!systemDark?.matches);
        document.body.classList.toggle('dark-mode', dark);
        // keep the browser/OS chrome (PWA status bar, mobile URL bar) in step
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = dark ? '#17222d' : '#ffffff';   // = the top bar, so the status bar and the bar read as one slab
    };
    if (systemDark?.addEventListener) {
        systemDark.addEventListener('change', () => { if (themeSetting() === 'system') Actions.applyTheme(); });
    }

    /** Settings → Identity key: which key this device holds, and whether it is the dev inbox key. */
    Render.identityLine = function () {
        const line = $('identity-line');
        if (!line) return;
        const pk = (window.SkateChat && SkateChat.getIdentity().pk) || (() => { try { return JSON.parse(localStorage.getItem('skate_identity_v1') || '{}').pk; } catch { return null; } })();
        if (!pk) { line.textContent = 'This device has no chat key yet; one is created the first time a community feature or the feedback sheet opens.'; return; }
        const dev = pk === (CFG.devPubkey || CFG.ownerPubkey);
        let npub = pk;
        try { npub = NostrTools.nip19.npubEncode(pk); } catch {}
        line.textContent = `This device: ${npub.slice(0, 12)}…${npub.slice(-6)} · dev inbox ${dev ? 'on' : 'off'}` + (!dev && SkateSettings.get('dmsAllowed') === false ? ' · Allow DMs is off (Privacy above)' : '');
    };

    /** Silent full data reload (programs + alerts + spots) — shared by the
     *  Refresh button and the resume-from-background path. */
    Actions.reloadData = async function () {
        SkateAPI._skatingPrograms = null;
        S.programs = (await SkateAPI.getSkatingPrograms(true)) || [];   // force: bypass HTTP cache
        mergedExtraSig = null; mergeLiveExtras();
        SkateAlerts.load(true);             // force (still ≥60s-gapped internally)
        SkateLive.load(S.programs, true);
        S.facts = await SkateAPI.getVenueFacts(true);
        setLending(await SkateAPI.getLending(true));
        Actions.applyFilters(true);
    };

    Actions.refreshPrograms = async function () {
        const btn = $('btn-refresh');
        btn.disabled = true; btn.classList.add('spinning');
        $('status-data').textContent = 'Refreshing…';
        try {
            await Actions.reloadData();
            // v3.8a: "refresh" also means the app itself. An installed app can sit open for
            // weeks running old code; if the site has moved on, reload it (unless a message is half-typed).
            const upd = await Actions.checkForUpdate({ force: true });
            if (upd && !unsavedDraft()) {
                SkateUI.toast(`Updating the app to ${upd.version ? 'v' + upd.version : 'the latest version'}…`, 'info', 1500);
                setTimeout(() => location.reload(), 900);
                return;
            }
            SkateUI.toast(upd ? 'Schedule refreshed. Finish your message, then tap Update at the top.' : 'Schedule, alerts and spots refreshed', 'success', upd ? 4000 : 2000);
        } catch (e) { SkateUI.toast('Refresh failed: ' + e.message, 'error'); }
        finally { Render.status(); btn.disabled = false; btn.classList.remove('spinning'); }
    };

    /* ---------- v3.8a: is the deployed site newer than the code running here? ----------
     * The ?v= tokens in index.html are the release identity: every change bumps
     * one. The running page's tokens are compared with a fresh copy of
     * index.html (never from any cache). On a mismatch the ↻ button reloads
     * the app; a page that has been open a while shows an Update bar instead,
     * so nobody keeps an old build just because they never closed the tab. */
    // v3.12.2: the members' entrance (gate.js) was missing here. A device that has been in
    // loads it quietly a moment after start, so every check said "a newer version is ready".
    // Anything the app adds later is also marked data-lazy and skipped, whatever its name.
    const LAZY_BASENAMES = new Set([...COMMUNITY_SCRIPTS, GATE_SCRIPT].map(s => s.split('/').pop().split('?')[0]));
    const signatureOf = (html) => {
        const found = new Set();
        for (const t of html.matchAll(/<[a-z][^>]*?\b(?:src|href)="[^"]*\?v=\d+"[^>]*>/gi)) {
            if (/\sdata-lazy\b/i.test(t[0])) continue;
            const base = /\b(?:src|href)="([^"]*\?v=\d+)"/i.exec(t[0])[1].split('/').pop();
            if (!LAZY_BASENAMES.has(base.split('?')[0])) found.add(base);
        }
        return [...found].sort().join('|');
    };
    let runningSignature = null, lastUpdateCheck = 0, updateSnoozedUntil = 0;
    const pageLoadedAt = Date.now();
    const unsavedDraft = () => !!(($('chat-input') && $('chat-input').value.trim()) || ($('devchat-input') && $('devchat-input').value.trim()) || ($('guide-body-input') && $('guide-body-input').value.trim()));
    Actions.checkForUpdate = async function ({ force = false } = {}) {
        const now = Date.now();
        if (!force && now - lastUpdateCheck < 10 * 60000) return null;
        lastUpdateCheck = now;
        if (runningSignature === null) runningSignature = signatureOf(document.documentElement.outerHTML);
        try {
            const r = await fetch(`./?fresh=${now}`, { cache: 'no-store' });
            if (!r.ok) return null;
            const html = await r.text();
            const remote = signatureOf(html);
            if (!remote || remote === runningSignature) { Render.updateBar(null); return null; }
            let version = '';
            const cfg = html.match(/config\.js\?v=(\d+)/);
            if (cfg) {
                try { version = (((await (await fetch(`projects/js/config.js?v=${cfg[1]}`, { cache: 'no-store' })).text()).match(/version:\s*'([^']+)'/) || [])[1]) || ''; } catch {}
            }
            const upd = { version, signature: remote };
            if (!force && now < updateSnoozedUntil) return upd;
            Render.updateBar(upd);
            return upd;
        } catch { return null; }   // offline or blocked: nothing to say
    };

    Render.updateBar = function (upd) {
        const bar = $('update-bar');
        if (!bar) return;
        if (!upd) { bar.classList.add('hidden'); return; }
        $('update-text').textContent = `A newer version of the app is ready${upd.version ? ` (v${upd.version})` : ''}.`;
        bar.classList.remove('hidden');
    };

    /** The doorbell: asks the CI to re-pull the City's export (status popover). */
    Actions.requestCityRefresh = async function () {
        try {
            await ensureNostrTools();                               // the doorbell signs a throwaway note
            const res = await SkateRefresh.requestCityRefresh();   // toasts on queued/failed itself
            if (res === 'cancelled') SkateUI.toast('No pull requested. Showing the latest published schedule.', 'info', 2500);
        } catch (e) { SkateUI.toast('Could not send the request: ' + e.message, 'error'); }
    };

    /* ================= Bindings ================= */
    function bind() {
        // ---- Search (as you type, debounced; ✕ clears) ----
        let searchTimer = null;
        const runSearch = () => {
            S.search = $('search-input').value.trim();
            $('btn-search-clear').classList.toggle('hidden', !S.search);
            Actions.applyFilters();
        };
        $('search-input').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); };
        $('search-input').onkeydown = e => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(); $('search-input').blur(); } };
        $('btn-search-clear').onclick = () => { $('search-input').value = ''; runSearch(); };

        // ---- Toolbar ----
        $('btn-filters').onclick = Actions.openFilters;
        $('btn-rinks').onclick = () => Actions.openRinks();
        $('btn-list').onclick = () => Actions.setCalMode(false);
        $('btn-cal').onclick = () => Actions.setCalMode(true);
        $('btn-cal-type').onclick = (e) => { e.stopPropagation(); Popover.open($('btn-cal-type'), Menus.calTypes(), 'Which calendar'); };
        $('btn-refresh').onclick = () => Actions.refreshPrograms();
        $('btn-free').onclick = () => Actions.setFlag('free', S.paidVisible);

        // ---- Pills (the city pill opens a picker; its x clears to every city) ----
        delegate($('active-filters'), [
            ['.pill.city .pill-x', (x, e) => { e.stopPropagation(); Actions.setCities([]); }],
            ['.pill.city', (b, e) => { e.stopPropagation(); Popover.open(b, Menus.cities(), 'Cities'); }],
            ['.pill.type .pill-x', (x, e) => { e.stopPropagation(); Actions.removePill(x.closest('.pill').dataset.pill); }],
            ['.pill.type', (b, e) => { e.stopPropagation(); const cat = b.dataset.pill.slice(5); Popover.open(b, cat === OTHER_KEY ? Menus.otherTypes() : Menus.subTypes(cat), cat === OTHER_KEY ? 'Other kinds' : subMenuTitle(cat)); }],
            ['.pill.radius .pill-x', (x, e) => { e.stopPropagation(); Actions.setRadius(null); }],
            ['.pill.radius', (b, e) => { e.stopPropagation(); Popover.open(b, Menus.radius(), 'How far from your spot'); }],
            ['.pill', (b) => Actions.removePill(b.dataset.pill)]
        ]);

        // ---- Status line + weather ----
        $('status-data').onclick = (e) => { e.stopPropagation(); Popover.open($('status-data'), Menus.status(), 'Sessions shown'); };
        // v3.16: the bar's day and date
        $('db-when').onclick = (e) => { e.stopPropagation(); Popover.open($('db-when'), Menus.when(), 'Day'); };
        $('db-date').onclick = (e) => { e.stopPropagation(); Actions.openDates(); };
        // v3.16: Feedback, Refresh, Members and Settings under ⋮
        {
            const more = $('btn-more'), menu = $('more-menu');
            const setMore = (open) => { menu.classList.toggle('hidden', !open); more.setAttribute('aria-expanded', open ? 'true' : 'false'); };
            more.onclick = (e) => { e.stopPropagation(); setMore(menu.classList.contains('hidden')); };
            menu.addEventListener('click', (e) => { if (e.target.closest('.more-item')) setMore(false); });
            document.addEventListener('click', (e) => { if (!e.target.closest('.more-wrap')) setMore(false); }, true);
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.classList.contains('hidden')) setMore(false); });
            // the dot on ⋯ follows the dots inside it (an unseen release, a members' note)
            const syncDot = () => $('more-dot').classList.toggle('hidden', ![...menu.querySelectorAll('.more-item:not(.hidden) .new-dot, .more-item:not(.hidden) .badge')].some(d => !d.classList.contains('hidden')));
            new MutationObserver(syncDot).observe(menu, { subtree: true, attributes: true, attributeFilter: ['class'] });
            syncDot();
        }
        $('btn-status-close').onclick = () => Modal.close('status-modal');
        delegate($('status-body'), [
            ['[data-st-all]', (b) => { S.statusAll = b.dataset.stAll === '1'; Render.dataStatus(); }],
            ['[data-st-refresh]', () => { Modal.close('status-modal'); Actions.refreshPrograms(); }],
            ['[data-st-city]', () => { Modal.close('status-modal'); Actions.requestCityRefresh(); }]
        ]);
        $('weather-chip').onclick = (e) => { e.stopPropagation(); Popover.open($('weather-chip'), Menus.weather(), 'Weather'); };
        delegate($('saved-next'), [['.saved-row', (b) => Actions.focusProgram(b.dataset.pid)]]);

        // ---- Filters sheet ----
        $('btn-filters-close').onclick = Actions.closeFilters;
        $('f-free').onchange = (e) => Actions.setFlag('free', e.target.checked);   // v3.15.2: the header switch
        $('btn-filters-apply').onclick = Actions.closeFilters;
        $('btn-filters-reset').onclick = Actions.resetFilters;
        let sheetTap = null;   // the row under the finger when the touch began (Android hit-test drift guard)
        $('filters-body').addEventListener('pointerdown', (e) => { const row = e.target.closest('.fcheck'); sheetTap = row ? { row, t: Date.now() } : null; }, { passive: true });
        $('filters-body').addEventListener('change', (e) => {
            let t = e.target;
            if (sheetTap && Date.now() - sheetTap.t < 800 && t.type === 'checkbox' && !sheetTap.row.contains(t) && sheetTap.row.isConnected) {
                // the page moved between finger-down and the click: undo the stray toggle, apply the intended one
                t.checked = !t.checked;
                const want = sheetTap.row.querySelector('input[type="checkbox"]');
                if (want) { want.checked = !want.checked; t = want; }
            }
            sheetTap = null;
            if (t.id === 'f-age') return Actions.setAge(t.value);
            if (t.dataset.flag) return Actions.setFlag(t.dataset.flag, t.checked);
            if (t.dataset.kind) return Actions.setKind(t.dataset.kind, t.checked);
            if (t.dataset.type) return Actions.setType(t.dataset.type, t.dataset.sub || null, t.checked);
        });
        delegate($('filters-body'), [
            ['[data-clear-age]', () => Actions.setAge('')],
            ['.fexpand, .ftoggle', (b) => {
                const k = b.dataset.expand;
                if (k === '__filters') S.moreFilters = !S.moreFilters;
                else S.expandedCats[k] = b.getAttribute('aria-expanded') !== 'true';   // explicit: closes even with a partial pick
                rerenderFilters();
            }],
            ['.fchip[data-day]', (b) => Actions.setDay(b.dataset.day)],
            ['.fchip[data-dates]', () => Actions.setDates(null)],
            ['.fchip[data-city]', (b) => (b.dataset.city ? Actions.toggleCity(b.dataset.city) : Actions.setCities([]))],
            ['.fchip[data-sort]', (b) => Actions.setSort(b.dataset.sort)],
            ['.fchip[data-radius]', (b) => Actions.setRadius(b.dataset.radius ? Number(b.dataset.radius) : null)],
            ['.flink[data-open]', () => { Modal.close('filters-modal'); Actions.openRinks(); }]
        ]);

        // ---- Week calendar ----
        const calStep = (n) => {
            if (cal2Active()) S.cal2Day = SkateTime.addDays(S.cal2Day || SkateTime.todayKey(), n);
            else S.calWeekOffset += n;
            Render.calendar();
        };
        $('btn-cal-prev').onclick = () => calStep(-1);
        $('btn-cal-next').onclick = () => calStep(1);
        $('btn-cal-today').onclick = () => { S.calWeekOffset = 0; S.cal2Day = SkateTime.todayKey(); Render.calendar(); };
        delegate($('calendar-view'), [
            ['[data-cal2-by]', (b) => Actions.cal2SetBy(b.dataset.cal2By)],
            ['[data-cal2-radius]', (b) => Actions.setRadius(b.dataset.cal2Radius ? Number(b.dataset.cal2Radius) : null)],
            ['[data-cal2-locate]', async (b) => {
                b.disabled = true; b.textContent = 'Locating…';
                try { SkateGeo.setUserLocation(await SkateGeo.locateMe()); locationChanged(); }
                catch (e) { Actions.openRinks({ ask: `${e.message} Type a place or a postal code instead.` }); }
            }],
            ['[data-cal2-place]', () => Actions.openRinks({ ask: 'Type a place or a postal code, then tap the line that appears under the box.' })],
            ['[data-cal2-ended]', (b, e) => { e.stopPropagation(); Actions.cal2ToggleEnded(); }],
            ['[data-cal2-fav]', (b, e) => { e.stopPropagation(); const p = S.filtered.find(x => P.id(x) === b.dataset.cal2Fav); if (p) Actions.toggleSaved(p); }],
            ['[data-cal2-day]', (b) => Actions.cal2SetDay(b.dataset.cal2Day)],
            ['.cal-daychip', (b) => SkateCalendar.scrollToDate($('calendar-view'), b.dataset.scrollDate)],
            ['.cal-block', (block, e) => {
                e.stopPropagation();
                const p = S.filtered.find(x => P.id(x) === block.dataset.pid);
                if (p) Popover.open(block, Menus.calBlock(p, block), p.Activity || p['Course Title'] || 'Session');
            }]
        ]);

        // ---- List rows + show more ----
        delegate($('program-list'), [
            ['.loc-note', (n, e) => { e.stopPropagation(); SkateUI.toast(n.dataset.note, 'info', 6000); }],
            ['.heart-hint-x', (b, e) => { e.stopPropagation(); SkateSettings.set('heartHintDone', true); Render.programs(); }],
            ['button[data-act]', (btn) => {
                const p = S.filtered[parseInt(btn.dataset.idx)];
                if (!p) return;
                const act = btn.dataset.act;
                if (act === 'fav') Actions.toggleSaved(p);
                else if (act === 'copy') Popover.open(btn, Menus.programCopy(p, btn), p.Activity || p['Course Title'] || 'Session');
            }]
        ]);
        delegate($('show-more'), [['button[data-more]', (b) => { S.limit = b.dataset.more === 'all' ? Infinity : S.limit + 30; Render.programs(); }]]);

        // ---- Rinks & map ----
        $('btn-rinks-close').onclick = Actions.closeRinks;
        $('btn-share-location').onclick = Actions.useMyLocation;
        $('btn-clear-location').onclick = Actions.clearLocation;
        $('btn-install').onclick = Actions.openInstall;
        // The feedback sheet rides the chat stack: load it on first use.
        Actions.openDevChat = async () => {
            try { await loadCommunityCode(); } catch { SkateUI.toast('Could not load the chat code. Check your connection and try again.', 'error', 4000); return; }
            SkateDev.open();
        };
        $('btn-devchat').onclick = Actions.openDevChat;
        $('btn-feedback').onclick = Actions.openDevChat;
        $('devchat-link').onclick = Actions.openDevChat;
        // v3.9: one backup to carry everything to another browser or phone
        $('btn-export-bundle').onclick = async () => {
            try { await loadCommunityCode(); } catch { SkateUI.toast('Could not load the chat code. Try again online.', 'error', 3000); return; }
            if (!window.SkateChat.booted) await Actions.bootCommunity().catch(() => {});
            const json = JSON.stringify(SkateChat.exportBundle());
            try {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
                a.download = `toronto-skating-backup-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a); a.click(); a.remove();
            } catch {}
            copyText(json, 'Backup copied (and downloaded). On the other device: Settings → Import, paste it. It holds your private chat key: keep it to yourself.');
        };
        $('btn-import-key').onclick = async () => {
            try { await loadCommunityCode(); } catch { SkateUI.toast('Could not load the chat code. Try again online.', 'error', 3000); return; }
            const v = prompt('Paste a backup from Export (to move your settings, saved sessions and chat identity here), or the dev key (nsec or 64-character hex).');
            if (!v) return;
            if (/^\s*\{/.test(v)) {
                const res = SkateChat.importBundle(v);
                if (!res.ok) { SkateUI.toast(`That backup could not be used: ${res.error}`, 'error', 5000); return; }
                SkateUI.toast('Backup imported. Reloading…', 'success', 1500);
                setTimeout(() => location.reload(), 900);
                return;
            }
            const pk = SkateChat.importIdentity(v);   // works before the chat stack boots: the key is saved, init picks it up
            if (!pk) { SkateUI.toast('That is not a valid key. It should start with nsec1 or be 64 hex characters.', 'error', 5000); return; }
            const dev = pk === (CFG.devPubkey || CFG.ownerPubkey);
            let note = '';
            if (dev && SkateSettings.get('dmsAllowed') === false) { SkateSettings.set('dmsAllowed', true); note = ' Allow DMs was off on this device; it is on now so the inbox can receive.'; }
            Render.identityLine();
            SkateUI.toast(dev ? 'Dev inbox is on for this device.' + note : `Identity set (${pk.slice(0, 8)}…), but that is not the dev inbox key.`, dev ? 'success' : 'info', note ? 7000 : 5000);
            Actions.bootCommunity().then(() => { if (chatBooted) Render.chatUI(SkateChat.getState()); }).catch(() => {});
        };
        $('btn-reset-key').onclick = async () => {
            if (!confirm('Start a fresh chat identity on this device? Saved sessions, filters and settings stay. Chat names and private threads start over.')) return;
            try { await loadCommunityCode(); } catch { SkateUI.toast('Could not load the chat code. Try again online.', 'error', 3000); return; }
            const pk = SkateChat.resetIdentity();
            Render.identityLine();
            SkateUI.toast(`New identity: ${pk.slice(0, 8)}…`, 'success', 3500);
            if (chatBooted) Render.chatUI(SkateChat.getState());
        };
        $('btn-install-close').onclick = () => Modal.close('install-modal');
        delegate($('install-hint'), [
            ['[data-install="how"]', Actions.openInstall],
            ['[data-install="later"]', () => { SkateSettings.set('installSeen', true); Render.installHint(); }]
        ]);
        $('btn-update-now').onclick = () => { $('update-text').textContent = 'Updating…'; location.reload(); };
        $('btn-update-later').onclick = () => { updateSnoozedUntil = Date.now() + 6 * 3600000; Render.updateBar(null); };
        // an app left open: look again when it comes back to the foreground after 30 min, and twice a day regardless
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && Date.now() - pageLoadedAt > 30 * 60000) Actions.checkForUpdate().catch(() => {});
        });
        setInterval(() => Actions.checkForUpdate().catch(() => {}), 12 * 3600000);
        $('btn-locator-search').onclick = Actions.searchLocation;
        $('rinks-search').oninput = Actions.rinkSearchTyped;
        $('btn-rinks-search-clear').onclick = () => Actions.clearRinkSearch();
        $('rinks-search').onkeydown = (e) => {
            if (e.key === 'Escape' && $('rinks-search').value) { e.stopPropagation(); Actions.clearRinkSearch(); return; }
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const raw = $('rinks-search').value.trim();
            const postal = /^[a-z]\d[a-z]\s?(\d[a-z]\d)?$/i.test(raw);
            // a postal code, or text no rink matches, is a place to measure from; otherwise Enter just puts the keyboard away
            if (raw.length >= 3 && (postal || !$('rinks-list').querySelector('.rink-row'))) Actions.searchLocation();
            else $('rinks-search').blur();
        };
        delegate($('rinks-list'), [
            ['[data-loc-filter]', (b) => Actions.filterToRink(b.dataset.locFilter, b.dataset.locName)],
            ['[data-loc-star]', (b) => Actions.toggleMyRink(b.dataset.locStar)],
            // v3.7b: anywhere on the row flies the map to the rink's pin and opens it
            ['[data-map-focus]', (b) => {
                SkateMap.focusRink(b.dataset.mapFocus);
                const row = b.closest('.rink-row');
                if (row) { row.classList.add('focused'); setTimeout(() => row.classList.remove('focused'), 1600); }
            }]
        ]);
        delegate($('rinks-scope'), [
            ['[data-rinks-scope]', (b) => { S.rinksAllCities = b.dataset.rinksScope === 'all'; Render.rinks(); SkateMap.refresh(); }]
        ]);
        delegate($('map-filter-seg'), [
            ['button[data-mapfilter]', (b) => SkateMap.setFilter(b.dataset.mapfilter)]
        ]);
        // popup buttons render inside the Leaflet container → one delegate
        delegate($('map-canvas'), [
            ['[data-map-sessions]', (b) => Actions.filterToRink(b.dataset.mapSessions, b.dataset.mapName)],
            ['[data-map-star]', (b) => {
                Actions.toggleMyRink(b.dataset.mapStar);
                const mine = (SkateSettings.get('myRinks') || []).includes(b.dataset.mapStar);
                SkateUI.toast(mine ? 'Added to your rinks' : 'Removed from your rinks', 'success', 2000);
            }]
        ]);

        // ---- Settings ----
        $('btn-settings').onclick = Actions.openSettings;
        // members' entrance: the button exists only on a device that has been let in
        $('btn-gate').onclick = () => Actions.openGate();
        if (gateKnown()) {
            $('btn-gate').classList.remove('hidden');
            (window.requestIdleCallback || ((fn) => setTimeout(fn, 1500)))(() => Actions.openGate({ quiet: true }));
        }
        $('btn-settings-close').onclick = () => Modal.close('settings-modal');
        // v3.17.2: no calendar switch in Settings any more: the ▾ beside Calendar picks the week grid or a day planner view
        $('btn-whatsnew').onclick = () => { Modal.close('settings-modal'); Actions.openWhatsNew(); };
        $('btn-whatsnew-close').onclick = () => Modal.close('whatsnew-modal');
        // v3.11: free skates. The chip on a session, the line under a day heading and the
        // link in Rinks & map all carry data-lending; caught first so the card behind stays shut.
        $('btn-lending-close').onclick = () => Modal.close('lending-modal');
        // v3.12: natural ice, the second link in Rinks & map
        $('btn-natural').onclick = () => Actions.openNatural();
        $('btn-natural-close').onclick = () => Modal.close('natural-modal');
        document.addEventListener('click', (e) => {
            const hit = e.target.closest && e.target.closest('[data-lending]');
            if (!hit) return;
            e.preventDefault(); e.stopPropagation();
            Actions.openLending();
        }, true);
        $('btn-show-qr').onclick = () => Actions.openQr();
        $('btn-qr-close').onclick = () => Modal.close('qr-modal');
        const copySite = () => copyText(CFG.siteUrl, 'Site link copied. Send it anywhere.');
        $('btn-copy-site').onclick = copySite;
        $('btn-qr-copy').onclick = copySite;
        $('btn-start-tour').onclick = () => { Modal.close('settings-modal'); Actions.switchView('programs'); SkateTour.start(); };
        $('btn-play-guide').onclick = () => { Modal.close('settings-modal'); Actions.switchView('programs'); SkateTour.play(); };
        $('btn-save-name').onclick = async () => {
            // the chat code validates names (word list); load it if this device never chatted
            try { await loadCommunityCode(); } catch { SkateUI.toast('Could not load the chat code to check the name. Try again online.', 'error', 3000); return; }
            if (!window.SkateChat.booted) { await Actions.bootCommunity().catch(() => {}); }
            if (SkateChat.setDisplayName($('settings-name').value)) SkateUI.toast('Name updated', 'success', 2000);
            else SkateUI.toast('That name will not work. Try another.', 'error', 2500);
        };
        delegate($('settings-timefmt'), [
            ['button[data-fmt]', (b) => { SkateSettings.set('timeFormat', b.dataset.fmt); Render.settings(); }]
        ]);
        delegate($('settings-theme'), [
            ['button[data-theme]', (b) => { SkateSettings.set('theme', b.dataset.theme); Actions.applyTheme(); Render.settings(); }]
        ]);
        delegate($('settings-sections'), [
            ['button[data-vis]', (b) => {
                SkateSettings.set(b.dataset.vis, SkateSettings.get(b.dataset.vis) === false);
                Actions.applyVisibility();
                Render.settings();
            }]
        ]);
        delegate($('settings-privacy'), [
            ['button[data-priv]', (b) => {
                const def = CFG.privacyToggles.find(t => t.id === b.dataset.priv);
                const cur = SkateSettings.get(def.id);
                const effective = cur == null ? !!def.default : cur;
                SkateSettings.set(def.id, !effective);
                if (chatBooted) SkateChat.applyPrivacy();
                if (def.id === 'notifyDesktop' && !effective) Actions.enableNotifications();
                Render.settings();
            }]
        ]);

        // ---- Chats — list ----
        $('btn-discover').onclick = () => Modal.open('discover-modal');
        delegate($('conversation-list'), [
            ['.conv-item', (row) => Actions.openConversation(row.dataset.kind, row.dataset.id)]
        ]);

        // ---- Chats — conversation ----
        $('btn-back').onclick = Actions.backToList;
        $('btn-chat-menu').onclick = e => {
            e.stopPropagation();
            const s = SkateChat.getState();
            Popover.open($('btn-chat-menu'), Menus.conversation(), s.viewMode === 'dm' ? (s.activeDmThread?.name || 'Conversation') : (s.activeGroup?.name || 'Conversation'));
        };
        $('btn-send').onclick = Actions.sendCurrent;
        $('chat-input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); Actions.sendCurrent(); } };
        $('chat-input').oninput = () => { const ta = $('chat-input'); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; };
        $('btn-reply-cancel').onclick = Actions.clearReply;
        $('jump-pill').onclick = () => {
            const msgs = $('chat-messages');
            msgs.scrollTop = msgs.scrollHeight;
            S.jumpBase = S.lastVisibleCount;
            $('jump-pill').classList.add('hidden');
        };
        $('chat-messages').addEventListener('scroll', () => {
            const msgs = $('chat-messages');
            if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80) {
                S.jumpBase = S.lastVisibleCount;
                $('jump-pill').classList.add('hidden');
            }
        });
        delegate($('members-list'), [
            ['.member-chip', (chip, e) => { e.stopPropagation(); Popover.open(chip, Menus.user(chip.dataset.pk, chip.dataset.name), chip.dataset.name || 'Skater'); }]
        ]);
        delegate($('chat-messages'), [
            ['a', () => { /* links behave like links */ }],
            ['[data-load-earlier]', async (b, e) => {
                e.stopPropagation();
                const st = SkateChat.getState();
                const kind = st.viewMode === 'dm' ? 'dm' : 'group';
                const id = kind === 'dm' ? st.activeDmRecipient : st.activeGroup?.id;
                const msgs = $('chat-messages');
                const h = msgs.scrollHeight, top = msgs.scrollTop;
                const added = await SkateChat.loadOlder(kind, id);
                S.jumpBase += added;   // older history is not "new messages"
                requestAnimationFrame(() => requestAnimationFrame(() => { msgs.scrollTop = top + (msgs.scrollHeight - h); }));
                if (!added) SkateUI.toast('That is all the history the relays still hold.', 'info', 2500);
            }],
            ['[data-react]', (chip, e) => {
                e.stopPropagation();
                const st = SkateChat.getState();
                const kind = st.viewMode === 'dm' ? 'dm' : 'group';
                const id = kind === 'dm' ? st.activeDmRecipient : st.activeGroup?.id;
                const mid = chip.closest('.chat-msg')?.dataset.mid;
                if (mid) SkateChat.react(kind, id, mid, chip.dataset.react);
            }],
            ['[data-open-program]', (n) => { Actions.switchView('programs'); Actions.focusProgram(n.dataset.openProgram); }],
            ['[data-open-guide]', (n) => Actions.openGuide(n.dataset.openGuide)],
            ['.reply-ref[data-ref]', (n) => Actions.scrollToMsg(n.dataset.ref)],
            ['.sender[data-pk]', (n, e) => { e.stopPropagation(); Popover.open(n, Menus.user(n.dataset.pk, n.dataset.name), n.dataset.name || 'Skater'); }],
            ['.chat-msg', (msgEl, e) => {
                const st = SkateChat.getState();
                const m = findMessage(st, msgEl.dataset.local || msgEl.dataset.mid);
                if (!m) return;
                e.stopPropagation();
                Popover.open(msgEl.querySelector('.bubble') || msgEl, Menus.message(m, st), m.mine ? 'Your message' : `${m.from || 'Skater'}'s message`);
            }]
        ]);

        // ---- Discover modal ----
        $('btn-discover-close').onclick = () => Modal.close('discover-modal');
        delegate($('discover-rooms'), [
            ['[data-leave]', (leave) => {
                if (confirm(`Leave ${leave.dataset.roomName}?`)) SkateChat.leaveGroup(leave.dataset.leave);
            }],
            ['.room-card', async (card) => {
                try {
                    await SkateChat.joinPublicRoom(card.dataset.room);
                    Modal.close('discover-modal');
                    S.chatOpen = true;
                    Actions.switchView('chats');
                    Actions.focusChatInput();
                } catch (err) { SkateUI.toast(err.message, 'error'); }
            }]
        ]);
        $('btn-create-group').onclick = async () => {
            try {
                const name = $('group-name-input').value.trim();
                const password = $('group-password-input').value.trim() || null;
                if (!name) return SkateUI.toast('Give your group a name first', 'error', 2000);
                const { invite } = await SkateChat.createGroup({ name, password });
                $('group-name-input').value = ''; $('group-password-input').value = '';
                Modal.close('discover-modal');
                S.chatOpen = true;
                Actions.switchView('chats');
                if (invite) copyText(invite.url, invite.hasPassword
                    ? 'Group created and the invite link copied. Friends will also need the password.'
                    : 'Group created and the invite link copied.');
            } catch (e) { SkateUI.toast(e.message, 'error'); }
        };
        $('btn-join-link').onclick = () => {
            const raw = $('join-link-input').value.trim();
            if (!raw) return;
            const hashPart = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw;
            const inv = SkateChat.parseInviteHash(hashPart);
            if (!inv) return SkateUI.toast('That does not look like a valid invite link', 'error');
            $('join-link-input').value = '';
            Modal.close('discover-modal');
            Actions.showInvite(inv);
        };

        // ---- Invite modal ----
        $('btn-invite-join').onclick = Actions.confirmInvite;
        $('invite-pw-input').onkeypress = e => { if (e.key === 'Enter') Actions.confirmInvite(); };
        $('btn-invite-cancel').onclick = Actions.dismissInvite;
        $('btn-invite-close').onclick = Actions.dismissInvite;

        // ---- Share modal ----
        $('btn-share-close').onclick = () => { S.shareCtx = null; Modal.close('share-modal'); };
        $('btn-share-discover').onclick = () => { Modal.close('share-modal'); Modal.open('discover-modal'); };
        delegate($('share-dest-list'), [
            ['.share-dest', (row) => Actions.doShare({ kind: row.dataset.kind, id: row.dataset.id, name: row.dataset.name })]
        ]);

        // ---- Guides ----
        delegate($('guides-list'), [
            ['[data-vote]', (v, e) => { e.stopPropagation(); Actions.toggleGuideVote(v.dataset.vote, v); }],
            ['[data-guide]', (card) => Actions.openGuide(card.dataset.guide)]
        ]);
        delegate($('guide-detail-content'), [
            ['[data-vote]', (v) => Actions.toggleGuideVote(v.dataset.vote, v)],
            ['[data-guide-copy]', (n) => copyText(`${baseUrl()}#guide=${n.dataset.guideCopy}`, 'Guide link copied')],
            ['[data-guide-share]', (n) => {
                const g = SkateGuides.get(n.dataset.guideShare);
                if (g) Actions.shareGuideFromDetail(g);
            }]
        ]);
        delegate($('guide-comments-list'), [
            ['[data-vote]', (v) => Actions.toggleGuideVote(v.dataset.vote, v)],
            ['[data-reply-comment]', (n) => Actions.setGuideReply(n.dataset.replyComment, n.dataset.name)]
        ]);
        $('btn-guide-reply-cancel').onclick = Actions.clearGuideReply;
        $('btn-guide-back').onclick = Actions.closeGuide;
        $('btn-write-guide').onclick = () => { $('guides-home').classList.add('hidden'); $('guide-write').classList.remove('hidden'); };
        $('btn-write-back').onclick = () => { $('guide-write').classList.add('hidden'); $('guides-home').classList.remove('hidden'); };
        $('btn-guide-submit').onclick = Actions.submitGuide;
        $('btn-guide-comment').onclick = Actions.submitGuideComment;
        $('guide-comment-input').onkeypress = e => { if (e.key === 'Enter') Actions.submitGuideComment(); };

        Modal.bindOverlays((id) => {
            if (id === 'invite-modal') { S.pendingInvite = null; Actions.clearHash(); }
        });

        // Keyboard: 1-N switch views, Esc walks back (popover → modal → conversation)
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                if (Popover.isOpen()) return Popover.close();
                const modal = Modal.any();
                if (modal) {
                    modal.classList.add('hidden');
                    if (modal.id === 'invite-modal') { S.pendingInvite = null; Actions.clearHash(); }
                    return;
                }
                if (S.chatOpen && $('chats-panel').classList.contains('active')) return Actions.backToList();
                return;
            }
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
            const n = parseInt(e.key);
            const visibleViews = CFG.views.filter(viewVisible);
            if (n >= 1 && n <= visibleViews.length) Actions.switchView(visibleViews[n - 1].id);
        });
    }

    /* ---------- toronto.ca as the ground truth ----------
       The weekly export lags the live system both ways: it keeps sessions
       the City dropped (hidden via isDropped) and lacks sessions the City
       added. The pipeline lists those extras in live-check.json; here they
       become ordinary City rows, borrowing the rink's address from a
       sibling row or rinks.json. */
    let mergedExtraSig = null;
    const normKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    function parseAgeText(t) {
        const s = String(t || '').toLowerCase();
        let m;
        if ((m = s.match(/(\d+)\s*(?:years?)?\s*(?:to|-)\s*(\d+)/))) return { min: +m[1], max: +m[2] };
        if ((m = s.match(/(\d+)\s*(?:years?)?\s*(?:and over|and up|\+)/))) return { min: +m[1], max: null };
        if ((m = s.match(/(\d+)\s*(?:years?)?\s*(?:and under)/))) return { min: null, max: +m[1] };
        return { min: null, max: null };
    }
    function mergeLiveExtras() {
        const extra = SkateAlerts.liveExtra || [];
        const sig = extra.map(x => `${x.LocationID}|${x.date}|${x.start}|${x.title}`).join(';');
        if (sig === mergedExtraSig) return false;
        mergedExtraSig = sig;
        S.programs = S.programs.filter(p => !p.LiveOnly);
        const have = new Set(S.programs.filter(p => !p.Source || p.Source === 'city')
            .map(p => `${p['Location ID']}|${P.dateStr(p).slice(0, 10)}|${P.time(p)}|${normKey(P.activity(p))}`));
        extra.forEach(x => {
            if (!x || !x.date || !x.start) return;
            if (have.has(`${x.LocationID}|${x.date}|${x.start}|${normKey(x.title)}`)) return;
            const sibling = S.programs.find(p => (!p.Source || p.Source === 'city') && String(p['Location ID']) === String(x.LocationID));
            const rink = SkateGeo.rinkByLocation(x.LocationID);
            const age = parseAgeText(x.age);
            S.programs.push({
                _id: `live-${x.LocationID}-${x.date}-${x.start}`,
                'Location ID': x.LocationID,
                'Course Title': x.title, Activity: x.title, Section: 'Skating - Drop-In', Category: 'Skating - Drop-In',
                LocationName: sibling?.LocationName || rink?.name || `Location ${x.LocationID}`,
                LocationType: sibling?.LocationType || 'arena',
                Address: sibling?.Address || rink?.address || '', District: sibling?.District || rink?.district || '',
                PostalCode: sibling?.PostalCode || rink?.postal || '',
                Accessibility: sibling?.Accessibility || '', TTCInfo: sibling?.TTCInfo || '', Intersection: sibling?.Intersection || '',
                'Age Min': age.min, 'Age Max': age.max,
                'Start Time': x.start, 'End Time': x.end || '',
                'Day of Week': parseLocalDate(x.date).toLocaleDateString('en-CA', { weekday: 'long' }),
                'Start Date': x.date, 'End Date': x.date, 'First Date': x.date, 'Last Date': x.date,
                Source: 'city', LiveOnly: true
            });
        });
        return true;
    }

    /* ---------- iPhone: put the page back where it belongs (v3.12.1) ----------
     * The app is a fixed shell: the page itself never scrolls, only the panels in it.
     * iOS Safari leaves the page scrolled all the same in two cases: after the phone is
     * turned sideways and back (its toolbars return and the page stays shifted up), and
     * after the keyboard closes. It can also scroll one of the shell's own boxes to bring
     * a field into view. With nothing to scroll, the reader cannot drag any of it back.
     * So whenever the viewport changes and nobody is typing, the page and the shell's
     * boxes go back to zero. Left alone: a field under the keyboard (there iOS scrolled
     * on purpose) and a page the reader has pinched into (that view is theirs).
     */
    const SHELL_BOXES = ['html', 'body', '.app', '.main-content'];      // these never scroll; the panels inside them do
    function settleViewport() {
        const a = document.activeElement;
        const typing = !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
        const vv = window.visualViewport;
        if (vv && vv.scale > 1.02) return false;                                    // pinched in
        if (typing && vv && vv.height < window.innerHeight - 80) return false;      // the keyboard is up
        let moved = false;
        for (const sel of SHELL_BOXES) {
            const box = document.querySelector(sel);
            if (box && (box.scrollTop || box.scrollLeft)) { box.scrollTop = 0; box.scrollLeft = 0; moved = true; }
        }
        if (window.scrollX || window.scrollY || (vv && (vv.offsetTop > 0.5 || vv.offsetLeft > 0.5))) { window.scrollTo(0, 0); moved = true; }
        return moved;
    }
    /** After the phone is turned: make WebKit lay the page out again against the viewport it has now. */
    function nudgeLayout() {
        if (!window.matchMedia || !matchMedia('(pointer: coarse)').matches) return;
        const de = document.documentElement;
        de.style.height = '100.01%';        // nothing to see: a tenth of a pixel, for one frame
        requestAnimationFrame(() => { de.style.height = ''; settleViewport(); });
    }
    function watchViewport() {
        let timers = [], nudge = 0;
        // iOS reports the new size before it has finished moving its toolbars: look again a few times
        const soon = () => { timers.forEach(clearTimeout); timers = [50, 250, 600, 1200].map(ms => setTimeout(settleViewport, ms)); };
        const turned = () => { soon(); clearTimeout(nudge); nudge = setTimeout(nudgeLayout, 350); };
        window.addEventListener('orientationchange', turned);
        if (window.screen && screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', turned);
        window.addEventListener('resize', soon);
        window.addEventListener('pageshow', soon);
        if (window.visualViewport) window.visualViewport.addEventListener('resize', soon);
        document.addEventListener('focusout', () => setTimeout(settleViewport, 150));   // the keyboard went away
    }

    /* ================= Boot ================= */
    async function init() {
        Render.bootstrap();
        Actions.applyTheme();
        watchViewport();
        // installed iPhone/iPad copies only: the bar's content starts below iOS 26's
        // status-bar band (see the CSS). A Mac web app also reports standalone, and an
        // iPad reports itself as a Mac, so touch capability is the tie-breaker.
        const touchApple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && 'ontouchend' in document);
        document.documentElement.classList.toggle('ios-standalone', touchApple && isStandalone());
        bind();

        // Everyone lands on the schedule (the first tab), on every device.
        // Brand-new visitors get ONE lightweight setup screen (sections +
        // rinks, all skippable); existing users are grandfathered past it.
        // Favorites are loaded here, not in the community boot — the ❤️
        // hearts must work even on a schedule-only (no chat/guides) visit.
        SkateFavorites.load();
        const freshInstall = Actions.firstRun();
        Actions.applyVisibility();   // also kicks off bootCommunity() if a section is visible
        initPullToRefresh();

        // Rink map + service alerts load in parallel with programs;
        // whichever lands last re-renders so badges/distances appear.
        SkateGeo.load();
        SkateAlerts.load();
        SkateWeather.load();
        SkateGeo.onUpdate(() => {
            if (S.programs.length) Actions.applyFilters(true);
            if (!$('rinks-modal').classList.contains('hidden')) { Render.rinks(); SkateMap.refresh(); }
        });
        SkateAlerts.onUpdate(() => { if (S.programs.length) { mergeLiveExtras(); Actions.applyFilters(true); } });
        SkateLive.onUpdate(() => { if (S.programs.length) Render.programs(); });
        SkateWeather.onUpdate(Render.weather);

        // Map popups pull their content/actions from app-side data
        SkateMap.configure({
            popupHtml: mapPopupHtml,
            userPoint: () => SkateGeo.getUserLocation(),
            rinkFilter: rinkShown,           // the pins follow the cities AND the rink search
            onFilter: () => Render.rinks()   // the list follows All / Indoor / Outdoor
        });

        try {
            const programs = await SkateAPI.getSkatingPrograms();
            S.programs = programs || [];
            mergeLiveExtras();
            Actions.applyFilters();
            SkateLive.load(S.programs);   // live venue spots (TTL-throttled)
            // v3.7: rentals / helmets per rink; never delays the schedule
            SkateAPI.getVenueFacts().then(f => { S.facts = f; if (S.programs.length) Render.programs(); });
            // v3.11: free skates; like the facts, it never delays the schedule
            SkateAPI.getLending().then(l => { setLending(l); if (l && S.programs.length) Render.programs(); }).catch(() => {});
            if (S.pendingProgramFocus) { Actions.focusProgram(S.pendingProgramFocus); S.pendingProgramFocus = null; }
            // Brand-new visitor: the spotlight tour, Skip front and centre.
            if (freshInstall && !SkateSettings.get('tourDone')) setTimeout(() => SkateTour.play(), 700);
        } catch (e) {
            $('program-list').innerHTML = '<li class="loading">Could not load the schedule. Pull to refresh or try again later.</li>';
        }

        // Keep "Starts in Xm / On now · Xm left" honest and let just-ended
        // sessions drop off — re-filter once a minute, preserving the page.
        // Same tick refreshes live venue spots AND service alerts (both
        // self-throttle: spots 5 min, alerts ~5 min) — an open tab is never
        // more than minutes behind the deployed alert snapshot.
        setInterval(() => {
            if (S.programs.length && document.visibilityState !== 'hidden') {
                Actions.applyFilters(true);
                SkateLive.load(S.programs);
                SkateAlerts.load();
                SkateWeather.load();   // 30-min TTL inside
            }
        }, 60000);

        // Resume-from-background (phone unlock, PWA/bookmark reopen, bfcache
        // restore): the Aug 4 incident's second half — a page loaded in the
        // morning silently showed morning alerts all day. On wake: force-pull
        // alerts + spots, recompute status chips; after 24h+ asleep, reload
        // the whole dataset too (the schedule itself may have shifted).
        const bootAt = Date.now();
        let lastFullReload = bootAt;
        const resumeFreshness = () => {
            if (!S.programs.length || document.visibilityState === 'hidden') return;
            SkateAlerts.load(true);           // ≥60s-gapped internally, so tab-flapping is harmless
            SkateLive.load(S.programs);
            Actions.applyFilters(true);       // "Starts in Xm" chips recompute instantly
            if (Date.now() - lastFullReload > 24 * 3600 * 1000) {
                lastFullReload = Date.now();
                Actions.reloadData().catch(() => {});
            }
        };
        document.addEventListener('visibilitychange', resumeFreshness);
        window.addEventListener('pageshow', (e) => { if (e.persisted) resumeFreshness(); });

        // Community stack (chat + guides + relays) boots only when a
        // community section is visible; deep links await it via route paths.
        if (communityWanted()) await Actions.bootCommunity();
        SkateSettings.onChange(() => { Render.programs(); if (chatBooted) Render.chatUI(SkateChat.getState()); });

        Actions.route();
        window.addEventListener('hashchange', Actions.route);
    }

    return { init, S, Render, Actions, officialUrl, officialSite, rinkCity, settleViewport };
})();

SkateApp.init();
