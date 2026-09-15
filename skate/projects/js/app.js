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

    const S = {
        programs: [], filtered: [], limit: 30, paidMatching: 0,
        search: '', showPast: false, age: null, savedOnly: false,
        // v3.2 filters. Persisted: types {cat: 'all' | [subtype…]} ({} = every
        // type), cities ([] = everywhere), paidVisible, rinkScope, sort.
        // Session-only: day, age, savedOnly, showPast, nearRink.
        types: sanitizeTypes(SkateSettings.get('typeSel')),
        cities: Array.isArray(SkateSettings.get('cities')) ? SkateSettings.get('cities').filter(c => typeof c === 'string') : [],
        day: '',                       // '' | 'today' | 'tomorrow' | 'weekend' | weekday name
        calOpen: new Set(),            // calendar time blocks expanded in place ('YYYY-MM-DD|HH')
        calRenderedWeek: null,         // to keep the grid's scroll position across the minute re-render
        heartHint: false,              // first card carries the one-time "tap ♡ to save" nudge (Render.programs decides)
        cal2Mode: SkateSettings.get('cal2Mode') || 'at',      // Calendar 2.0 layout (at | rinks | hours | week)
        cal2Day: null,                 // Calendar 2.0's selected day (today until tapped)
        cal2ScrollHour: null,          // heat cell → open Hours at this hour
        cal2At: null,                  // "Open at" slider position in minutes (null = follow now / 6 PM)
        paidVisible: !!SkateSettings.get('paidVisible'),
        rinkScope: SkateSettings.get('rinkScope') || 'all',
        sort: SkateSettings.get('sort') || 'time',
        calMode: !!SkateSettings.get('calMode'),
        calWeekOffset: 0,
        showDropped: false,            // include City sessions toronto.ca no longer lists (hidden by default: toronto.ca is the ground truth)
        moreFilters: false,            // Filters sheet: the collapsed "More options" section
        rinksAllCities: false,         // Rinks view: ignore the Where cities for one look
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
        id:       p => SkateChat.Favorites.getId(p),

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
        matchesTypes(p, types = S.types) {
            if (!Object.keys(types).length) return true;
            const sel = types[P.category(p)];
            if (!sel) return false;
            return sel === 'all' || sel.includes(P.subType(p));
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
    /** Same, for a rinks.json entry (map popups / locator). */
    function officialUrlForRink(r) {
        if (!r) return null;
        if (r.source === 'city' && /^\d+$/.test(String(r.locationid))) return TORONTO_LOC_URL + r.locationid;
        return httpOnly(r.website);
    }

    /** 7.5 → "7.50", 5 → "5", null → "?" — prices read like a price tag. */
    function fmtPrice(n) { return n == null ? '?' : Number(n).toFixed(2).replace(/\.00$/, ''); }

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
            (p.Paid ? `\nPaid${p.Price != null ? ', $' + fmtPrice(p.Price) : ''}` : (p.PriceNote ? `\n${p.PriceNote}` : '')) +
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
            p.Paid ? `Paid session${p.Price != null ? ` · $${fmtPrice(p.Price)}` : ''}${p.RegistrationUrl ? ` · ${p.RegistrationUrl === p.InfoUrl ? 'Details' : 'Register'}: ${p.RegistrationUrl}` : ''}` : (p.PriceNote || 'Free drop-in'),
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
                SkateChat.Notify.toast('Calendar file saved. Open it to add the session.', 'success', 2500);
                return;
            } catch (e) { /* home server unreachable: build the file here */ }
        }
        downloadIcs(p);
    }

    function downloadIcs(p) {
        const ev = calEvent(p);
        if (!ev) return SkateChat.Notify.toast('This session has no date to add', 'error');
        const blob = new Blob([icsText(ev)], { type: 'text/calendar;charset=utf-8' });
        if (isIOS()) {
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            return;
        }
        saveBlob(blob, icsFileName(p));
        SkateChat.Notify.toast('Calendar file saved. Open it to add the session.', 'success', 2500);
    }
    function openCalendarLink(p, kind) {
        const ev = calEvent(p);
        if (!ev) return SkateChat.Notify.toast('This session has no date to add', 'error');
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
            onPick: id => { S.chatFilter = id; Render.conversations(SkateChat.getState()); },
            extra: (btn, it) => { if (it.dynamic) btn.classList.add('hidden'); }
        });

        // Guide category chips + write-form select
        const cats = SkateGuides.CATEGORIES;
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
    function upcomingSplit(key, nowMs = Date.now()) {
        let free = 0, paid = 0;
        S.programs.forEach(p => {
            if (P.locKey(p) !== key) return;
            if (SkateTime.status(p, nowMs).phase === 'ended' || SkateAlerts.isDropped(p)) return;
            if (p.Paid) paid++; else free++;
        });
        return { free, paid };
    }

    /* ---------- Active filters as removable pills ---------- */
    const SUB_LABEL = id => (CFG.subTypes.find(x => x.id === id) || {}).label || id;
    const CAT_LABEL = id => (CFG.programTypes.find(x => x.id === id) || {}).label || id;
    const DAY_LABEL = d => d === 'today' ? 'Today' : d === 'tomorrow' ? 'Tomorrow' : d === 'weekend' ? 'Weekend' : (d || '').slice(0, 3);

    /** Everything currently narrowing the list, in pill form (key → label). */
    function activeFilterPills() {
        const pills = [];
        Object.entries(S.types).forEach(([cat, sel]) => {
            const subs = sel === 'all' ? '' : sel.length === 1 ? `: ${SUB_LABEL(sel[0])}` : `: ${SUB_LABEL(sel[0])} +${sel.length - 1}`;
            pills.push({ key: `type:${cat}`, label: `${CAT_LABEL(cat)}${subs}`, ages: subsPresentFor(cat).length > 1 });
        });
        if (S.day) pills.push({ key: 'day', label: DAY_LABEL(S.day) });
        if (S.age !== null) pills.push({ key: 'age', label: `Age ${S.age}` });
        if (S.savedOnly) pills.push({ key: 'saved', label: 'Saved only' });
        if (S.nearRink) pills.push({ key: 'near', label: `Only ${S.nearRink.name}` });
        if (S.showPast) pills.push({ key: 'past', label: 'Ended shown' });
        if (S.showDropped) pills.push({ key: 'dropped', label: 'Dropped shown' });
        if (S.sort === 'near') pills.push({ key: 'sort', label: 'Nearest first' });
        return pills;
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
            if (pl.ages) {
                // type pill: tap = choose age groups, x = drop the type
                wrap.appendChild(el('button', { class: 'pill type', dataset: { pill: pl.key }, title: 'Tap to choose age groups. The x removes this type.' }, [
                    el('span', { class: 'pill-label' }, [pl.label]),
                    el('span', { class: 'pill-caret', 'aria-hidden': 'true' }, ['▾']),
                    el('span', { class: 'pill-x', role: 'button', 'aria-label': `Remove ${pl.label}`, title: 'Remove this type' }, ['✕'])
                ]));
                return;
            }
            wrap.appendChild(el('button', { class: 'pill', dataset: { pill: pl.key }, title: 'Remove this filter' }, [
                pl.label, el('span', { class: 'pill-x', 'aria-hidden': 'true' }, ['✕'])
            ]));
        });
        const n = pills.length + (S.rinkScope === 'mine' && mine ? 1 : 0) + (S.cities.length ? 1 : 0);
        $('filters-count').textContent = String(n);
        $('filters-count').classList.toggle('hidden', !n);
        $('btn-filters').classList.toggle('active', !!n);
        $('btn-list').classList.toggle('active', !S.calMode);
        $('btn-list').setAttribute('aria-pressed', S.calMode ? 'false' : 'true');
        $('btn-cal').classList.toggle('active', S.calMode);
        $('btn-cal').setAttribute('aria-pressed', S.calMode ? 'true' : 'false');
        $('btn-paid').classList.toggle('active', S.paidVisible);
        $('btn-paid').setAttribute('aria-pressed', S.paidVisible ? 'true' : 'false');
        $('btn-paid').title = S.paidVisible ? 'Paid venues are shown. Tap to hide them.' : 'Paid venues are hidden. Tap to show them with prices.';
    };

    /* ---------- Filters sheet ---------- */
    /** Counts by category / sub-type / city over the dataset (dropped City sessions excluded unless shown). */
    function filterFacets() {
        const cats = {}, cities = {};
        let paid = 0;
        S.programs.forEach(p => {
            if (!S.showDropped && SkateAlerts.isDropped(p)) return;
            const c = P.category(p), st = P.subType(p);
            (cats[c] ||= { n: 0, subs: {} });
            cats[c].n++;
            cats[c].subs[st] = (cats[c].subs[st] || 0) + 1;
            const city = P.city(p);
            cities[city] = (cities[city] || 0) + 1;
            if (p.Paid) paid++;
        });
        return { cats, cities, paid };
    }
    const cityKeys = (cities) => Object.keys(cities).sort((a, b) => {
        const ia = CFG.cityOrder.indexOf(a), ib = CFG.cityOrder.indexOf(b);
        return ((ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)) || a.localeCompare(b);
    });
    const subsPresentFor = (cat) => {
        const f = filterFacets().cats[cat];
        return f ? CFG.subTypes.map(x => x.id).filter(id => f.subs[id]) : [];
    };

    // The everyday kinds sit first; the rest fold away behind "More types".
    const MAIN_TYPES = ['leisure', 'figure', 'hockey'];

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
        const chip = (label, on, dataset) => el('button', { class: 'fchip' + (on ? ' active' : ''), dataset, 'aria-pressed': on ? 'true' : 'false' }, [label]);
        const foldBtn = (key, open, label) => el('button', { class: 'ftoggle' + (open ? ' open' : ''), dataset: { expand: key }, 'aria-expanded': open ? 'true' : 'false' }, [label, el('span', { class: 'caret', 'aria-hidden': 'true' }, ['▾'])]);

        /** One category row (+ its age groups) appended to `host`. */
        const typeRow = (cat, host) => {
            const facet = f.cats[cat.id];
            if (!facet) return;                                     // not in this dataset
            const sel = S.types[cat.id];
            const subsPresent = CFG.subTypes.filter(x => facet.subs[x.id]);
            const hasSubs = subsPresent.length > 1;
            const open = hasSubs && (!!S.expandedCats[cat.id] || (!!sel && sel !== 'all'));
            const row = el('div', { class: `fcat type-${cat.id}` + (sel ? ' on' : '') });
            row.appendChild(check(cat.label, !!sel, { type: cat.id }, ' cat'));
            row.appendChild(count(facet.n));
            if (hasSubs) row.appendChild(el('button', { class: 'fexpand' + (open ? ' open' : ''), dataset: { expand: cat.id }, title: open ? 'Hide the age groups' : 'Choose age groups', 'aria-expanded': open ? 'true' : 'false' }, ['Ages ', el('span', { class: 'caret', 'aria-hidden': 'true' }, ['▾'])]));
            else row.appendChild(el('span', { class: 'fexpand-spacer', 'aria-hidden': 'true' }));   // keeps the counts in one column
            host.appendChild(row);
            if (hasSubs) {
                const subs = el('div', { class: 'fsubs' + (open ? '' : ' hidden') });
                subsPresent.forEach(x => {
                    const on = sel === 'all' || (Array.isArray(sel) && sel.includes(x.id));
                    const c = check(x.label, !!sel && on, { type: cat.id, sub: x.id });
                    c.appendChild(count(facet.subs[x.id]));
                    subs.appendChild(c);
                });
                host.appendChild(subs);
            }
        };

        // WHAT: leisure, figure, hockey up front; the rest behind one fold
        const t = section('What kind of skating');
        CFG.programTypes.filter(c => MAIN_TYPES.includes(c.id)).forEach(c => typeRow(c, t));
        const rest = CFG.programTypes.filter(c => !MAIN_TYPES.includes(c.id) && f.cats[c.id]);
        if (rest.length) {
            const open = !!S.expandedCats.__more || rest.some(c => S.types[c.id]);
            t.appendChild(foldBtn('__more', open, `${open ? 'Fewer' : 'More'} types: ${rest.map(c => c.label).join(', ')}`));
            const more = el('div', { class: 'fmore' + (open ? '' : ' hidden') });
            rest.forEach(c => typeRow(c, more));
            t.appendChild(more);
        }

        // WHEN
        const w = section('When');
        const days = el('div', { class: 'fchips' });
        [['', 'Any day'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['weekend', 'Weekend'], ...CFG.days.map(d => [d, d.slice(0, 3)])]
            .forEach(([id, label]) => days.appendChild(chip(label, S.day === id, { day: id })));
        w.appendChild(days);

        // WHERE
        const where = section('Where');
        const cityRow = el('div', { class: 'fchips' });
        cityRow.appendChild(chip('All cities', !S.cities.length, { city: '' }));
        cityKeys(f.cities).forEach(c => cityRow.appendChild(chip(`${c} · ${f.cities[c]}`, S.cities.includes(c), { city: c })));
        where.appendChild(cityRow);
        const mine = (SkateSettings.get('myRinks') || []).length;
        const mineRow = check(`My rinks only${mine ? ` (${mine})` : ''}`, S.rinkScope === 'mine', { flag: 'mine' });
        mineRow.appendChild(el('button', { class: 'flink', dataset: { open: 'rinks' } }, [mine ? 'Edit' : 'Pick rinks']));
        where.appendChild(mineRow);
        where.appendChild(check(`Include paid venues (${f.paid})`, S.paidVisible, { flag: 'paid' }));

        // MORE: age, ended, saved-only, dropped, order (folded unless something in it is set)
        const inUse = S.age !== null || S.showPast || S.savedOnly || S.showDropped || S.sort !== 'time';
        const openMore = S.moreFilters || inUse;
        const m = section('');
        m.appendChild(foldBtn('__filters', openMore, `${openMore ? 'Fewer' : 'More'} options: age, ended sessions, saved, order`));
        const mbody = el('div', { class: 'fmore' + (openMore ? '' : ' hidden') });
        const ageInput = el('input', { type: 'number', min: '0', max: '120', id: 'f-age', placeholder: 'any', inputmode: 'numeric', 'aria-label': 'Age' });
        if (S.age !== null) ageInput.value = S.age;
        mbody.appendChild(el('label', { class: 'fage' }, ['Only sessions open to someone aged ', ageInput]));
        mbody.appendChild(check('Include sessions that already ended', S.showPast, { flag: 'past' }));
        mbody.appendChild(check('Only sessions I saved', S.savedOnly, { flag: 'saved' }));
        const dropped = SkateAlerts.liveStats?.missing || 0;
        if (dropped) mbody.appendChild(check(`Include the ${dropped} City session${dropped === 1 ? '' : 's'} toronto.ca no longer lists`, S.showDropped, { flag: 'dropped' }));
        const ord = el('div', { class: 'fchips forder' }, [el('span', { class: 'flabel' }, ['Order'])]);
        CFG.sortOptions.forEach(x => ord.appendChild(chip(x.label, S.sort === x.id, { sort: x.id })));
        mbody.appendChild(ord);
        if (S.sort === 'near' && !SkateGeo.getUserLocation()) mbody.appendChild(el('p', { class: 'settings-hint' }, ['Nearest needs your location. Set it under Rinks and map.']));
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
                : mode === 'at' ? 'Drag to a time of day. The bars show how many rinks are open through the day; the list is who is open at that moment, your rinks first and nearest next. Tap a card for details.'
                : mode === 'hours' ? 'Each chip is one session: start, rink, length. Tap it for details and actions.'
                : mode === 'rinks' ? 'One row per rink; a bar runs as long as the session. Swipe sideways through the day, tap a bar for details.'
                : mode === 'week' ? 'Darker = more sessions on the ice that hour. Tap an hour to open it, or a day name for the whole day.'
                : 'Tap a session for details and actions; tap a time block to open it.'}</span>`;
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
            if (!SkateChat.Favorites.has(p)) return;
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
            return a ? { cls: ' is-warn', txt: `${soon ? soon + ' · ' : ''}rink alert` } : { cls: '', txt: soon };
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
            if (SkateChat.Favorites.has(p) && SkateTime.status(p, nowMs).phase === 'ended') SkateChat.Favorites.remove(p);
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

        Object.entries(metadata.sources || {}).forEach(([key, s]) => {
            if (s.ok !== false) return;
            const label = CFG.sourceInfo[key]?.label || key;
            wrap.innerHTML += `<div class="alert-banner warning">
                <strong>The ${escapeHtml(label)} feed failed at the last update.</strong>
                Its sessions may be missing or stale${s.count ? ` (showing ${s.count} kept from the previous run)` : ''}.
            </div>`;
        });
    };

    Render.programs = function () {
        const { filtered } = S;
        const chatState = SkateChat.getState();
        const now = new Date();
        Render.dataWarnings(SkateAPI.getMetadata(), now);
        Render.status();
        Render.pills();
        pruneEndedSaved(now.getTime());
        Render.savedNext();

        // list ↔ week (the Week button)
        $('calendar-wrap').classList.toggle('hidden', !S.calMode);
        $('program-list').classList.toggle('hidden', S.calMode);
        $('show-more').classList.toggle('hidden', S.calMode);
        if (S.calMode) return Render.calendar();

        const list = $('program-list');
        if (!filtered.length) {
            const paidOnly = !S.paidVisible && S.paidMatching > 0;
            const empty = S.savedOnly ? 'Nothing saved yet. Tap ♡ on any session to keep it here.'
                : paidOnly ? `All ${S.paidMatching} matching session${S.paidMatching === 1 ? ' is' : 's are'} at paid venues. Tap Paid in the top bar to show them.`
                : S.rinkScope === 'mine' ? 'Nothing at your rinks with these filters. Tap the My rinks pill to see every rink.'
                : 'No sessions match. Try fewer filters, or tap the city pill to add cities.';
            list.innerHTML = `<li class="loading">${empty}</li>`;
            Render.showMore(0);
            return;
        }

        // the heart nudge rides the first card until a first save or "Got it";
        // anyone who already has saved sessions never sees it
        if (!SkateSettings.get('heartHintDone') && SkateChat.Favorites.count()) SkateSettings.set('heartHintDone', true);
        S.heartHint = !SkateSettings.get('heartHintDone');

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
                html += `<li class="day-head${d === todayKey ? ' today' : ''}"><span>${rel ? `<strong>${rel}</strong> · ` : ''}${escapeHtml(dt)}</span></li>`;
            }
            html += Render.programRow(p, i, chatState, now);
        });
        list.innerHTML = html;
        Render.showMore(filtered.length - items.length);
    };

    /** One quiet line: count · freshness (✓ or ⚠️ + time). Tap → details + refresh. */
    Render.status = function () {
        const btn = $('status-data');
        const now = Date.now();
        const meta = SkateAPI.getMetadata();
        const n = S.filtered.length;
        let txt = `${n} session${n === 1 ? '' : 's'}`;
        if (!S.paidVisible && S.paidMatching) txt += ` · ${S.paidMatching} paid hidden`;
        const stamps = [SkateAlerts.checkedAt, SkateAlerts.liveCheckedAt].filter(Boolean).map(x => new Date(x).getTime());
        const stale = (SkateAlerts.checkedAt && now - new Date(SkateAlerts.checkedAt) > ALERTS_STALE_MS) ||
                      (SkateAlerts.liveCheckedAt && now - new Date(SkateAlerts.liveCheckedAt) > LIVE_STALE_MS) ||
                      (meta?.lastUpdated && (now - new Date(meta.lastUpdated)) / 86400000 > 7);
        if (stamps.length) txt += ` · ${stale ? '⚠️' : '✓'} ${SkateSettings.formatTime(Math.max(...stamps))}`;
        else if (meta?.lastUpdated) txt += ` · updated ${new Date(meta.lastUpdated).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`;
        btn.textContent = txt;
        btn.classList.toggle('stale', !!stale);
    };

    Render.showMore = function (left) {
        const wrap = $('show-more');
        wrap.innerHTML = left > 0
            ? `<button class="btn-more" data-more="30">Show ${Math.min(30, left)} more <span class="btn-more-left">· ${left} left</span></button>` +
              (left > 30 ? `<button class="btn-more all" data-more="all">Show all ${left}</button>` : '')
            : '';
    };

    /** Settings → Display → Calendar 2.0 (experimental layouts; docs/calendar-2.md). */
    const cal2Active = () => SkateSettings.get('cal2') === true;

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
            isSaved: p => SkateChat.Favorites.has(p),
            alertFor: p => SkateAlerts.forProgram(p),
            statusFor: p => SkateTime.status(p),
            typeFor: p => P.typeCls(p),
            maxBlocks: 8,
            isOpen: (dateKey, hour) => S.calOpen.has(`${dateKey}|${hour}`)
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

    /** Calendar 2.0: hours / rinks / week layouts (SkateCalendar2), same popover as the grid. */
    Render.calendar2 = function () {
        const view = $('calendar-view');
        const todayKey = SkateTime.todayKey();
        if (!S.cal2Day) S.cal2Day = todayKey;
        const tor = new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false, hour: '2-digit', minute: '2-digit' });
        const nowMinutes = (+tor.slice(0, 2)) * 60 + (+tor.slice(3, 5));
        const mine = new Set(SkateSettings.get('myRinks') || []);
        const res = SkateCalendar2.render(view, S.filtered, {
            mode: S.cal2Mode, day: S.cal2Day, todayKey, nowMinutes, scrollHour: S.cal2ScrollHour,
            at: S.cal2At, onScrub: (t) => { S.cal2At = t; },
            fmtClock, fmtKm: SkateGeo.fmtKm,
            idFor: p => P.id(p),
            isSaved: p => SkateChat.Favorites.has(p),
            alertFor: p => SkateAlerts.forProgram(p),
            statusFor: p => SkateTime.status(p),
            typeFor: p => P.typeCls(p),
            rinkKey: p => P.locKey(p),
            rinkInfo: (key, p) => ({ mine: mine.has(key), dist: SkateGeo.distanceForProgram(p) })
        });
        S.cal2ScrollHour = null;
        S.calRenderedWeek = null;   // the classic grid must not restore a stale scroll when switched back
        setCalNav(res.mode !== 'week');
        $('cal-label').textContent = `${res.label} · ${res.total} session${res.total === 1 ? '' : 's'}`;
        Render.calLegend(res, res.mode);
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
        } else if (alert) {
            const closed = alert.level === 'closed';
            const lead = closed ? 'Likely cancelled, rink alert'
                : alert.padOnly ? 'One pad is closed here. This session likely runs on the other pad'
                : 'Service alert at this rink';
            alertHtml = `<div class="alert-banner ${closed ? 'closed' : 'warning'}"><strong>${lead}.</strong> ${escapeHtml(alert.reason)}${alert.text ? `. ${escapeHtml(alert.text)}` : ''}${verify}</div>`;
        }

        // Schedules read from a PDF or website have no live feed: say so, calmly.
        const unverifiedHtml = p.Unverified ? `<div class="alert-banner unverified"><strong>Unverified.</strong> Read from ${escapeHtml(site)}, no live feed. Check before you go${p.InfoUrl ? `: <a href="${escapeHtml(p.InfoUrl)}" target="_blank" rel="noopener">${escapeHtml(site)} ↗</a>` : '.'}</div>` : '';

        // Price as a price tag; notes (residents-only, age tiers) as a wrapping line
        const srcInfo = CFG.sourceInfo[p.Source];
        const price = p.Paid
            ? `<span class="price-badge paid" title="${escapeHtml(srcInfo?.note || 'Paid venue')}">$${fmtPrice(p.Price)}</span>`
            : '<span class="price-badge free">Free</span>';
        const noteBadge = p.PriceNote ? `<span class="note-badge">${escapeHtml(p.PriceNote)}</span>` : '';
        // Venues without online booking (PDF/HTML towns) link their schedule page instead.
        const registerLink = (p.Paid && p.RegistrationUrl)
            ? (p.RegistrationUrl === p.InfoUrl
                ? `<a class="row-link" href="${escapeHtml(p.RegistrationUrl)}" target="_blank" rel="noopener" title="The venue's schedule page. Pay at the door.">Details ↗</a>`
                : `<a class="row-link strong" href="${escapeHtml(p.RegistrationUrl)}" target="_blank" rel="noopener" title="The venue's registration page">Register ↗</a>`)
            : '';

        // Live spots (fetched from the venue's registration API in-browser).
        // DaySmart semantics (verified 2026-09-14): open_slots -1 = no cap,
        // registration_status ∈ open | upcoming | full | closed | null.
        const live = p.Paid ? SkateLive.forProgram(p) : null;
        let spotsBadge = '';
        if (live && st.phase !== 'ended') {
            if (live.status === 'full') {
                spotsBadge = '<span class="spots-badge full" title="The venue reports this session as full">Full</span>';
            } else if (live.status === 'closed') {
                spotsBadge = '<span class="spots-badge closed-reg" title="The venue\'s online registration for this session is closed">Registration closed</span>';
            } else if (live.status === 'upcoming') {
                spotsBadge = '<span class="spots-badge closed-reg" title="The venue has not opened online registration for this session yet">Registration opens later</span>';
            } else if (live.open != null) {
                spotsBadge = `<span class="spots-badge${live.open <= 20 ? ' low' : ''}" title="Live from the venue's registration system">${live.open}${live.capacity ? '/' + live.capacity : ''} spots left</span>`;
            } else if (live.unlimited && live.status === 'open') {
                spotsBadge = '<span class="spots-badge" title="No capacity limit set by the venue">Registration open</span>';
            }
        }

        const km = SkateGeo.distanceForProgram(p);
        const dist = km != null ? `<span class="dist">${SkateGeo.fmtKm(km)}</span>` : '';
        const note = CFG.locationNotes[String(p['Location ID'] ?? '')];
        const noteBtn = note ? `<button class="loc-note where-note" data-note="${escapeHtml(note)}" title="${escapeHtml(note)}" aria-label="Rink note">📝</button>` : '';

        const isFavorite = SkateChat.Favorites.has(p);
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
        const whereHtml = location
            ? `<a class="where-link" href="${mapsUrl(location, city)}" target="_blank" rel="noopener" title="Directions in Google Maps">📍 ${escapeHtml(location)} ↗</a>`
            : '';
        const infoLink = off
            ? `<a class="where-info" href="${escapeHtml(off)}" target="_blank" rel="noopener" title="Official page on ${escapeHtml(site)}. Verify the schedule there before you go." aria-label="Official page on ${escapeHtml(site)}"><svg class=\"where-glyph\" viewBox=\"0 0 16 16\" width=\"14\" height=\"14\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"6.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\"/><path d=\"M1.6 8h12.8M8 1.6c2.3 2.1 2.3 10.7 0 12.8M8 1.6c-2.3 2.1-2.3 10.7 0 12.8M2.8 4.6h10.4M2.8 11.4h10.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.1\"/></svg></a>`
            : '';
        // One-time nudge on the first card: people miss that the heart saves.
        const hint = (idx === 0 && S.heartHint)
            ? '<div class="heart-hint" role="note"><span>Try it: tap <b>♡</b> to save a session. Saved sessions come back as a reminder card up top.</span><button class="heart-hint-x" data-hint-x="1">Got it</button></div>'
            : '';

        return `
            <li class="program-item${rowStateCls}${p.Paid ? ' is-paid' : ''}${isFavorite ? ' is-saved' : ''}${alert ? (alert.level === 'closed' ? ' has-alert-closed' : ' has-alert') : ''}" data-pid="${pid}">
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
                    <div class="program-badges">${P.tagFor(p)}${P.ageBadge(p)}${price}${spotsBadge}</div>
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
        if (c.unread) meta.appendChild(el('span', { class: 'dm-unread-badge' }, [String(c.unread)]));
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

    Render.msg = function (m, isDm) {
        let cls = 'chat-msg';
        if (m.mine) cls += ' mine';
        if (m.system) cls += ' system';
        if (m.type === 'share') cls += ' share';
        if (m.type === 'guide') cls += ' share guide-share';

        let content = escapeHtml(m.text || '');
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
        } else if (m.type === 'guide' && m.data) {
            const cat = SkateGuides.CATEGORIES[m.data.category];
            content = `<strong>${escapeHtml(m.data.title)}</strong>` +
                (cat ? `<br><span class="guide-cat">${cat.emoji} ${escapeHtml(cat.name)}</span>` : '') +
                (m.data.excerpt ? `<br><em>“${escapeHtml(m.data.excerpt)}”</em>` : '') +
                `<br><span class="share-open" data-open-guide="${escapeHtml(m.data.guideId || '')}">Read the guide →</span>`;
        }

        const tick = !m.mine ? '' :
            m.status === 'pending' ? '<span class="msg-tick pending" title="Sending…">⏳</span>' :
            m.status === 'failed' ? '<span class="msg-tick failed" title="Not delivered. Tap the message to retry.">⚠ retry</span>' :
            '<span class="msg-tick" title="Delivered to relays">✓</span>';

        const sender = (!m.mine && !m.system)
            ? `<div class="sender" ${m.fromPubkey ? `data-pk="${m.fromPubkey}"` : ''} data-name="${escapeHtml(m.from || 'Skater')}" title="Tap for message / mute">${!isDm ? hueDot(m.fromPubkey) : ''}${escapeHtml(m.from || 'Skater')}</div>`
            : '';

        return `
            <div class="${cls}" data-mid="${escapeHtml(m.id)}"${m.localId ? ` data-local="${m.localId}"` : ''}>
                ${sender}
                <div class="bubble">${Render.replyRef(m.replyTo)}${content}${m.system ? '' : `<span class="msg-time">${SkateSettings.formatWhen(m.ts)}${tick}</span>`}</div>
            </div>`;
    };

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
                ? visible.map(m => Render.msg(m, true)).join('')
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
                ? visible.map(m => Render.msg(m, false)).join('')
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
        chip.textContent = `${w.emoji} ${w.temp}° · ${label.length > 18 ? label.slice(0, 17) + '…' : label} ▾`;
        chip.title = `${w.text} in ${w.label}: ${w.temp}°C, feels like ${w.feels}°C. Tap to pick another spot (Open-Meteo).`;
    };

    /* ---------- Rinks and map: one view for the map, distances and your rinks ---------- */
    /** Municipality of a rinks.json entry: Toronto for City rinks, else the feed's city or district. */
    function rinkCity(r) {
        return r.source === 'city' ? 'Toronto' : (CFG.sourceInfo[r.externalSource]?.city || r.district || 'Toronto');
    }
    /** The Where cities apply to the rink list and the map too (your rinks always show). */
    function rinkInScope(r) {
        if (!S.cities.length || S.rinksAllCities) return true;
        return S.cities.includes(rinkCity(r)) || (SkateSettings.get('myRinks') || []).includes(String(r.locationid));
    }

    Render.rinks = function () {
        const user = SkateGeo.getUserLocation();
        $('locator-status').textContent = user ? `Distances from ${user.label}` : 'Use your location or type an address for distances, or just browse.';
        const wrap = $('rinks-list');
        const scope = $('rinks-scope');
        wrap.innerHTML = '';
        scope.innerHTML = '';
        if (!SkateGeo.loaded || !SkateGeo.rinks.length) {
            wrap.appendChild(el('p', { class: 'settings-hint' }, ['Rink list still loading, one second.']));
            return;
        }
        const q = $('rinks-search').value.trim().toLowerCase();
        const mine = new Set(SkateSettings.get('myRinks') || []);
        let rows = SkateGeo.rinks
            .filter(rinkInScope)
            .map(r => ({ ...r, city: rinkCity(r), km: user && r.lat != null ? SkateGeo.distanceKm(user, { lat: r.lat, lng: r.lng }) : null }));
        if (q) rows = rows.filter(r => `${r.name} ${r.district || ''} ${r.city}`.toLowerCase().includes(q));
        rows.sort((a, b) =>
            (mine.has(String(b.locationid)) - mine.has(String(a.locationid))) ||   // yours first
            ((a.km ?? Infinity) - (b.km ?? Infinity)) ||                            // then nearest
            a.name.localeCompare(b.name));                                          // then A–Z

        // Scope line: which cities the list follows, with a one-tap way out.
        const cityScoped = S.cities.length && !S.rinksAllCities;
        scope.appendChild(el('span', {}, [`${rows.length} rink${rows.length === 1 ? '' : 's'}${S.cities.length ? (cityScoped ? ` in ${S.cities.join(', ')}` : ' in every city') : ''}`]));
        if (S.cities.length) scope.appendChild(el('button', { class: 'flink', dataset: { rinksScope: cityScoped ? 'all' : 'cities' } }, [cityScoped ? 'Show every city' : `Only ${S.cities.join(', ')}`]));

        const row = (r) => {
            const key = String(r.locationid);
            const sp = upcomingSplit(key);
            const sessions = S.paidVisible ? sp.free + sp.paid : sp.free;
            const alerts = SkateAlerts.forLocation(key);
            const starred = mine.has(key);
            const meta = [
                r.km != null ? SkateGeo.fmtKm(r.km) : null,
                r.address || null,
                (r.kinds || []).map(k => k === 'indoor' ? 'indoor' : 'outdoor').join(' + ') || null,
                r.paid ? 'paid' : null
            ].filter(Boolean).join(' · ');
            const label = sessions ? `${sessions} session${sessions === 1 ? '' : 's'}` : (sp.paid ? `${sp.paid} paid` : 'No sessions');
            const node = el('div', { class: 'rink-row' + (starred ? ' starred' : '') + (alerts.length ? ' has-alert' : '') });
            node.appendChild(el('div', { class: 'rink-info' }, [
                el('strong', {}, [r.name, ...(alerts.length ? [el('span', { class: 'rink-alert', title: 'Service alert: ' + alerts.map(a => a.Reason).join(', ') }, ['alert'])] : [])]),
                el('span', { class: 'rink-meta' }, [meta])
            ]));
            const sessionsBtn = el('button', {
                class: 'btn-small rink-sessions', dataset: { locFilter: key, locName: r.name },
                title: (sessions || sp.paid) ? 'Show only this rink\'s sessions' : 'No drop-in sessions listed for this rink'
            }, [label]);
            if (!sessions && !sp.paid) sessionsBtn.disabled = true;
            node.appendChild(el('div', { class: 'rink-actions' }, [
                sessionsBtn,
                el('button', { class: 'btn-small star' + (starred ? ' starred' : ''), dataset: { locStar: key }, title: starred ? 'Remove from my rinks' : 'Add to my rinks', 'aria-label': starred ? 'Remove from my rinks' : 'Add to my rinks' }, [starred ? '★' : '☆'])
            ]));
            return node;
        };
        const yours = rows.filter(r => mine.has(String(r.locationid)));
        const others = rows.filter(r => !mine.has(String(r.locationid)));
        if (yours.length) {
            wrap.appendChild(el('div', { class: 'rinks-head' }, [`Your rinks (${yours.length})`]));
            yours.forEach(r => wrap.appendChild(row(r)));
            if (others.length) wrap.appendChild(el('div', { class: 'rinks-head' }, ['Other rinks']));
        }
        others.slice(0, 80).forEach(r => wrap.appendChild(row(r)));
        if (!rows.length) wrap.appendChild(el('p', { class: 'settings-hint' }, ['No rink matches that.']));
    };

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
        requestAnimationFrame(() => {
            guidesRenderQueued = false;
            Render.guides();
            if (S.pendingGuideOpen && SkateGuides.get(S.pendingGuideOpen)) {
                const gid = S.pendingGuideOpen;
                S.pendingGuideOpen = null;
                Actions.openGuide(gid);
            }
        });
    }

    Render.guides = function () {
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
            const cat = SkateGuides.CATEGORIES[g.category] || {};
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
        const cat = SkateGuides.CATEGORIES[g.category] || {};
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
            if (!m.system) items.push({ ...A('reply'), onClick: () => Actions.setReply(m) });
            if (m.text) items.push({ ...A('copyText'), onClick: () => copyText(m.text) });
            if (m.type === 'share' && m.data?.programId) items.push({ ...A('openProgram'), onClick: () => { Actions.switchView('programs'); Actions.focusProgram(m.data.programId); } });
            if (m.type === 'guide' && m.data?.guideId) items.push({ ...A('openGuide'), onClick: () => Actions.openGuide(m.data.guideId) });
            if (m.mine && m.status === 'failed' && m.localId) {
                items.push({ ...A('retry'), onClick: () => SkateChat.retryMessage(isDm ? 'dm' : 'group', convId, m.localId) });
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
                        try { await SkateChat.renameGroup(g.id, name); } catch (e) { SkateChat.Notify.toast(e.message, 'error'); }
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
                    SkateChat.Notify.toast(mine ? `${P.location(p)} removed from your rinks` : `${P.location(p)} added to your rinks`, 'success', 2200);
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
            const items = [
                { label: `Schedule data: ${fmt(meta?.lastUpdated)}`, onClick: () => {} },
                { label: `Rink alerts checked: ${fmt(SkateAlerts.checkedAt)}`, onClick: () => {} },
                { label: `toronto.ca cross-check: ${fmt(SkateAlerts.liveCheckedAt)}${st ? ` (${st.missing} hidden as no longer listed, ${st.extra} added)` : ''}`, onClick: () => {} }
            ];
            if (st?.missing) items.push({ label: S.showDropped ? 'Hide the sessions toronto.ca no longer lists' : `Show the ${st.missing} session${st.missing === 1 ? '' : 's'} toronto.ca no longer lists`, onClick: () => Actions.setFlag('dropped', !S.showDropped) });
            items.push({ label: 'Refresh now', onClick: () => Actions.refreshPrograms() });
            items.push({ label: 'Ask for a fresh pull from the City', onClick: () => Actions.requestCityRefresh() });
            if (!S.paidVisible && S.paidMatching) items.push({ label: `Show ${S.paidMatching} paid sessions`, onClick: () => Actions.setFlag('paid', true) });
            return items;
        },

        /** Age-group picker behind a type pill (multi-select; stays open while you pick). */
        subTypes(cat) {
            const f = filterFacets().cats[cat];
            if (!f) return [];
            const sel = S.types[cat];
            const reopen = () => { const a = $('active-filters').querySelector(`.pill.type[data-pill="type:${cat}"]`); if (a) Popover.open(a, Menus.subTypes(cat)); };
            const items = [{ label: `${sel === 'all' ? '✓ ' : '\u2007\u2007 '}Every age group · ${f.n}`, onClick: () => { Actions.setType(cat, null, true); reopen(); } }];
            CFG.subTypes.filter(x => f.subs[x.id]).forEach(x => {
                const on = sel === 'all' || (Array.isArray(sel) && sel.includes(x.id));
                items.push({ label: `${on ? '✓ ' : '\u2007\u2007 '}${x.label} · ${f.subs[x.id]}`, onClick: () => { Actions.setType(cat, x.id, !on); reopen(); } });
            });
            return items;
        },

        /** City picker behind the standing city pill (multi-select; stays open while you pick). */
        cities() {
            const f = filterFacets().cities;
            const reopen = () => { const a = $('active-filters').querySelector('.pill.city'); if (a) Popover.open(a, Menus.cities()); };
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
            const fav = SkateChat.Favorites.has(p);
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

    Actions.switchView = view => Render.switchView(view);

    /** The filter pipeline, pure: state → sorted array (also sets S.paidMatching). */
    function computeFiltered() {
        const mine = new Set(SkateSettings.get('myRinks') || []);
        const nowMs = Date.now();
        const todayKey = SkateTime.todayKey(), tomorrowKey = SkateTime.addDays(todayKey, 1);
        const term = S.search.toLowerCase();
        const postalTerm = term.replace(/\s+/g, '');   // "M5A3S5" finds "M5A 3S5"
        const dayIsRel = ['today', 'tomorrow', 'weekend'].includes(S.day);

        let result = S.programs.filter(p => {
            if (!S.showDropped && SkateAlerts.isDropped(p)) return false;   // toronto.ca is the ground truth
            if (!P.matchesTypes(p)) return false;
            if (S.savedOnly && !SkateChat.Favorites.has(p)) return false;
            if (S.cities.length && !S.cities.includes(P.city(p))) return false;
            if (S.rinkScope === 'mine' && mine.size && !mine.has(P.locKey(p))) return false;
            if (S.nearRink && P.locKey(p) !== S.nearRink.key) return false;
            if (term && !(
                P.activity(p).toLowerCase().includes(term) ||
                P.location(p).toLowerCase().includes(term) ||
                (p.Address || '').toLowerCase().includes(term) ||
                (p.District || '').toLowerCase().includes(term) ||
                P.city(p).toLowerCase().includes(term) ||
                (postalTerm && (p.PostalCode || '').toLowerCase().replace(/\s+/g, '').includes(postalTerm)))) return false;
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
        });

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
        SkateSettings.set('typeSel', S.types);
        SkateSettings.set('cities', S.cities);
        SkateSettings.set('paidVisible', S.paidVisible);
        SkateSettings.set('rinkScope', S.rinkScope);
        SkateSettings.set('sort', S.sort);
    }
    /** Re-render after a filter change: sheet (if open) + list. */
    function filtersChanged() {
        persistFilters();
        if (!$('filters-modal').classList.contains('hidden')) Render.filters();
        Actions.applyFilters();
    }

    Actions.openFilters = function () { Render.filters(); Modal.open('filters-modal'); };
    Actions.closeFilters = function () { Modal.close('filters-modal'); };

    /** Category checkbox (sub=null) or one age group under it. */
    Actions.setType = function (cat, sub, on) {
        const types = { ...S.types };
        if (!sub) {
            if (on) types[cat] = 'all'; else delete types[cat];
        } else {
            const present = subsPresentFor(cat);
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
    Actions.toggleCity = function (c) {
        S.cities = S.cities.includes(c) ? S.cities.filter(x => x !== c) : [...S.cities, c];
        filtersChanged();
    };
    Actions.setCities = function (list) { S.cities = list; filtersChanged(); };
    Actions.setDay = function (d) { S.day = d || ''; filtersChanged(); };
    Actions.setAge = function (v) { const n = parseInt(v, 10); S.age = Number.isFinite(n) ? n : null; filtersChanged(); };
    Actions.setSort = function (id) {
        S.sort = id;
        if (id === 'near' && !SkateGeo.getUserLocation()) {
            Modal.close('filters-modal');
            SkateChat.Notify.toast('Nearest first needs your location. Set it here.', 'info', 3000);
            Actions.openRinks();
        }
        filtersChanged();
    };
    /** saved / past / mine / paid switches (Filters sheet + status popover + pills). */
    Actions.setFlag = function (flag, on) {
        if (flag === 'saved') S.savedOnly = !!on;
        else if (flag === 'past') S.showPast = !!on;
        else if (flag === 'paid') S.paidVisible = !!on;
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
        S.showPast = false; S.nearRink = null; S.rinkScope = 'all'; S.sort = 'time'; S.paidVisible = false;
        S.showDropped = false; S.moreFilters = false; S.expandedCats = {};
        filtersChanged();
    };
    /** Tapping a pill removes that one filter (or toggles ⭐ My rinks). */
    Actions.removePill = function (key) {
        if (key === 'mine') return Actions.setFlag('mine', S.rinkScope !== 'mine');
        if (key.startsWith('type:')) { const t = { ...S.types }; delete t[key.slice(5)]; S.types = t; }
        else if (key.startsWith('city:')) S.cities = S.cities.filter(c => c !== key.slice(5));
        else if (key === 'day') S.day = '';
        else if (key === 'age') S.age = null;
        else if (key === 'saved') S.savedOnly = false;
        else if (key === 'near') S.nearRink = null;
        else if (key === 'paid') S.paidVisible = false;
        else if (key === 'past') S.showPast = false;
        else if (key === 'dropped') S.showDropped = false;
        else if (key === 'cities') S.cities = [];
        else if (key === 'sort') S.sort = 'time';
        filtersChanged();
    };
    Actions.setCalMode = function (on) {
        S.calMode = !!on;
        SkateSettings.set('calMode', S.calMode);
        Render.programs();
    };

    /** Calendar 2.0: switch layout (remembered). */
    Actions.cal2SetMode = function (mode) {
        S.cal2Mode = mode;
        SkateSettings.set('cal2Mode', mode);
        Render.calendar();
    };

    /** Calendar 2.0: pick a day; from the week heatmap this lands in Hours (at `hour` when a cell was tapped). */
    Actions.cal2SetDay = function (day, hour = null) {
        S.cal2Day = day;
        if (S.cal2Mode === 'week') { S.cal2Mode = 'hours'; SkateSettings.set('cal2Mode', 'hours'); }
        S.cal2ScrollHour = hour;
        Render.calendar();
    };

    /** A calendar time block opens or closes in place (the grid re-renders, keeping its scroll). */
    Actions.toggleCluster = function (dateKey, hour) {
        const k = `${dateKey}|${hour}`;
        if (S.calOpen.has(k)) S.calOpen.delete(k); else S.calOpen.add(k);
        Render.calendar();
    };

    /** One tap, the right app: Apple devices get the .ics (Calendar), Android gets Google Calendar, other desktops pick. */
    Actions.addToCalendar = function (p, anchor) {
        if (isApple()) return openIcs(p);
        if (isAndroid()) return openCalendarLink(p, 'google');
        const at = (anchor && document.contains(anchor)) ? anchor : (document.querySelector(`.program-item[data-pid="${P.id(p)}"] .btn-copy`) || document.body);
        Popover.open(at, Menus.calendar(p));
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
        if (idx === -1) return SkateChat.Notify.toast('That session is not in the current schedule anymore', 'error');
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
            SkateSettings.set('paidVisible', true);
            SkateChat.Notify.toast(`${what || 'That rink'} only has paid sessions. Paid is now on so they show.`, 'info', 4000);
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
    Actions.openRinks = async function (opts = {}) {
        $('rinks-search').value = '';
        Render.rinks();
        try {
            await SkateMap.open(opts);   // shows #rinks-modal, lazy-loads Leaflet
        } catch (e) {
            SkateChat.Notify.toast('The map could not load. The rink list still works.', 'error');
        }
    };
    Actions.closeRinks = function () { SkateMap.close(); };

    /** After the user's point changes: distances everywhere, map dot, list order. */
    function locationChanged() {
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
        btn.disabled = false; btn.textContent = 'Use my location';
    };

    Actions.searchLocation = async function () {
        const btn = $('btn-locator-search');
        btn.disabled = true;
        $('locator-status').textContent = 'Searching…';
        try {
            const loc = await SkateGeo.geocode($('locator-input').value);
            SkateGeo.setUserLocation(loc);
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
        if (rink && rink.paid) { S.paidVisible = true; SkateSettings.set('paidVisible', true); }
        ensurePaidVisibleFor(key, name);
        SkateMap.close();
        Actions.applyFilters();
        SkateChat.Notify.toast(`Showing only ${name}. Tap the pill's x to clear.`, 'info', 3500);
    };

    /* ---------- Section visibility + first-visit setup ---------- */
    let chatBooted = false;   // guards the badge refresh before SkateChat.init()

    /**
     * Boot the community stack (profanity list → relays → guides) exactly
     * once, and only when a community section is actually visible. A
     * schedule-only visit (both sections hidden) opens zero websockets
     * and never downloads the profanity list.
     */
    let communityBootPromise = null;
    Actions.bootCommunity = function () {
        if (communityBootPromise) return communityBootPromise;
        communityBootPromise = (async () => {
            // The word list is display-critical (incoming messages run
            // through SkateMod.clean), so it loads BEFORE the relays connect.
            await new Promise(resolve => {
                const s = el('script', { src: 'projects/js/profanity-list.js' });
                s.onload = resolve;
                s.onerror = resolve;   // moderation degrades gracefully (remote checks remain)
                document.head.appendChild(s);
            });
            SkateMod.resetLocal();     // un-latch, in case anything checked early
            await SkateChat.init();
            chatBooted = true;
            SkateChat.onUpdate(Render.chatUI);
            SkateGuides.load();
            SkateGuides.onUpdate(scheduleGuidesRender);
            Render.chatUI(SkateChat.getState());
        })();
        return communityBootPromise;
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
        document.body.classList.toggle('hide-guides', SkateSettings.get('showGuides') === false);
        document.body.classList.toggle('hide-chats', SkateSettings.get('showChats') === false);
        Render.tabs();
        if (chatBooted) Render.chatUI(SkateChat.getState());   // repopulate the rebuilt badge
        if (communityWanted()) Actions.bootCommunity();        // late enable → boot now
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
            SkateChat.Notify.toast(`${visKey === 'showGuides' ? 'Guides' : 'Chats'} switched on. Hide it again in Settings.`, 'info', 3500);
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
        if (SkateChat.Favorites.toggle(p)) SkateSettings.set('heartHintDone', true);
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
        S.types = { leisure: 'all', figure: 'all' };
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

    Actions.openWhatsNew = function () {
        Render.whatsNew();
        SkateSettings.set('lastSeenVersion', CFG.version);
        $('settings-dot').classList.add('hidden');
        Modal.open('whatsnew-modal');
    };

    Actions.openGuide = function (id) {
        Actions.ensureSectionVisible('showGuides');
        Actions.switchView('guides');
        const g = SkateGuides.get(id);
        if (!g) {
            S.pendingGuideOpen = id;
            if (SkateGuides.loaded) SkateChat.Notify.toast('That guide is not on the relays yet', 'info', 3000);
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
            if (!ok) SkateChat.Notify.toast('The vote did not reach the relays. Try again.', 'error');
        } catch (e) { SkateChat.Notify.toast(e.message, 'error'); }
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
            else SkateChat.Notify.toast('The comment did not reach the relays', 'error');
        } catch (e) { SkateChat.Notify.toast(e.message, 'error'); }
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
                SkateChat.Notify.toast('Guide published', 'success');
                $('guide-title-input').value = ''; $('guide-body-input').value = '';
                $('guide-write').classList.add('hidden');
                $('guides-home').classList.remove('hidden');
                Render.guides();
            } else SkateChat.Notify.toast('The relays did not accept it. Try again.', 'error');
        } catch (e) { SkateChat.Notify.toast(e.message, 'error'); }
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
        Actions.focusChatInput();
    };

    Actions.startDm = function (pubkey, name) {
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
        if (!node) return SkateChat.Notify.toast('That message isn\'t loaded anymore', 'info', 2000);
        flash(node);
    };

    /* ---------- Share picker ---------- */
    Actions.openSharePicker = function (ctx) {
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
    Actions.route = function () {
        const hash = window.location.hash.slice(1);
        if (!hash || hash === lastRoutedHash) return;
        lastRoutedHash = hash;
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
        $('settings-name').value = SkateChat.getState().myName || '';
        $('btn-play-guide').textContent = `Watch the ${SkateTour.duration()}-second guide`;
        Render.settings();
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
        panel.addEventListener('touchstart', (e) => {
            if (busy || panel.scrollTop > 0 || Modal.any() || SkateTour.running) { startY = null; return; }
            startY = e.touches[0].clientY; pulling = false; armed = false;
        }, { passive: true });
        panel.addEventListener('touchmove', (e) => {
            if (startY === null || busy) return;
            const dy = e.touches[0].clientY - startY;
            if (dy <= 0 || panel.scrollTop > 0) { if (pulling) { pulling = false; armed = false; setPull(0); } return; }
            pulling = true;
            const px = Math.min(104, dy * 0.45);
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
                SkateChat.Notify.toast('Schedule, alerts and spots refreshed', 'success', 2000);
            } catch (e) {
                SkateChat.Notify.toast('Refresh failed: ' + e.message, 'error');
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

    /** Silent full data reload (programs + alerts + spots) — shared by the
     *  Refresh button and the resume-from-background path. */
    Actions.reloadData = async function () {
        SkateAPI._skatingPrograms = null;
        S.programs = (await SkateAPI.getSkatingPrograms(true)) || [];   // force: bypass HTTP cache
        mergedExtraSig = null; mergeLiveExtras();
        SkateAlerts.load(true);             // force (still ≥60s-gapped internally)
        SkateLive.load(S.programs, true);
        Actions.applyFilters(true);
    };

    Actions.refreshPrograms = async function () {
        const btn = $('btn-refresh');
        btn.disabled = true; btn.classList.add('spinning');
        $('status-data').textContent = 'Refreshing…';
        try {
            await Actions.reloadData();
            SkateChat.Notify.toast('Schedule, alerts and spots refreshed', 'success', 2000);
        } catch (e) { SkateChat.Notify.toast('Refresh failed: ' + e.message, 'error'); }
        finally { Render.status(); btn.disabled = false; btn.classList.remove('spinning'); }
    };

    /** The doorbell: asks the CI to re-pull the City's export (status popover). */
    Actions.requestCityRefresh = async function () {
        try {
            const res = await SkateRefresh.requestCityRefresh();   // toasts on queued/failed itself
            if (res === 'cancelled') SkateChat.Notify.toast('No pull requested. Showing the latest published schedule.', 'info', 2500);
        } catch (e) { SkateChat.Notify.toast('Could not send the request: ' + e.message, 'error'); }
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
        $('btn-refresh').onclick = () => Actions.refreshPrograms();
        $('btn-paid').onclick = () => Actions.setFlag('paid', !S.paidVisible);

        // ---- Pills (the city pill opens a picker; its x clears to every city) ----
        delegate($('active-filters'), [
            ['.pill.city .pill-x', (x, e) => { e.stopPropagation(); Actions.setCities([]); }],
            ['.pill.city', (b, e) => { e.stopPropagation(); Popover.open(b, Menus.cities()); }],
            ['.pill.type .pill-x', (x, e) => { e.stopPropagation(); Actions.removePill(x.closest('.pill').dataset.pill); }],
            ['.pill.type', (b, e) => { e.stopPropagation(); Popover.open(b, Menus.subTypes(b.dataset.pill.slice(5))); }],
            ['.pill', (b) => Actions.removePill(b.dataset.pill)]
        ]);

        // ---- Status line + weather ----
        $('status-data').onclick = (e) => { e.stopPropagation(); Popover.open($('status-data'), Menus.status()); };
        $('weather-chip').onclick = (e) => { e.stopPropagation(); Popover.open($('weather-chip'), Menus.weather()); };
        delegate($('saved-next'), [['.saved-row', (b) => Actions.focusProgram(b.dataset.pid)]]);

        // ---- Filters sheet ----
        $('btn-filters-close').onclick = Actions.closeFilters;
        $('btn-filters-apply').onclick = Actions.closeFilters;
        $('btn-filters-reset').onclick = Actions.resetFilters;
        $('filters-body').addEventListener('change', (e) => {
            const t = e.target;
            if (t.id === 'f-age') return Actions.setAge(t.value);
            if (t.dataset.flag) return Actions.setFlag(t.dataset.flag, t.checked);
            if (t.dataset.type) return Actions.setType(t.dataset.type, t.dataset.sub || null, t.checked);
        });
        delegate($('filters-body'), [
            ['.fexpand, .ftoggle', (b) => {
                const k = b.dataset.expand;
                if (k === '__filters') S.moreFilters = !S.moreFilters;
                else S.expandedCats[k] = !S.expandedCats[k];
                Render.filters();
            }],
            ['.fchip[data-day]', (b) => Actions.setDay(b.dataset.day)],
            ['.fchip[data-city]', (b) => (b.dataset.city ? Actions.toggleCity(b.dataset.city) : Actions.setCities([]))],
            ['.fchip[data-sort]', (b) => Actions.setSort(b.dataset.sort)],
            ['.flink[data-open]', () => { Modal.close('filters-modal'); Actions.openRinks(); }]
        ]);

        // ---- Week calendar ----
        const calStep = (n) => {
            if (cal2Active()) S.cal2Day = SkateTime.addDays(S.cal2Day || SkateTime.todayKey(), S.cal2Mode === 'week' ? 7 * n : n);
            else S.calWeekOffset += n;
            Render.calendar();
        };
        $('btn-cal-prev').onclick = () => calStep(-1);
        $('btn-cal-next').onclick = () => calStep(1);
        $('btn-cal-today').onclick = () => { S.calWeekOffset = 0; S.cal2Day = SkateTime.todayKey(); Render.calendar(); };
        delegate($('calendar-view'), [
            ['[data-cal2-mode]', (b) => Actions.cal2SetMode(b.dataset.cal2Mode)],
            ['[data-cal2-cell]', (b) => { const [d, h] = b.dataset.cal2Cell.split('|'); Actions.cal2SetDay(d, +h); }],
            ['[data-cal2-day]', (b) => Actions.cal2SetDay(b.dataset.cal2Day)],
            ['.cal-daychip', (b) => SkateCalendar.scrollToDate($('calendar-view'), b.dataset.scrollDate)],
            ['.cal-cluster', (b, e) => { e.stopPropagation(); Actions.toggleCluster(b.dataset.cluster, b.dataset.hour); }],
            ['.cal-block', (block, e) => {
                e.stopPropagation();
                const p = S.filtered.find(x => P.id(x) === block.dataset.pid);
                if (p) Popover.open(block, Menus.calBlock(p, block));
            }]
        ]);

        // ---- List rows + show more ----
        delegate($('program-list'), [
            ['.loc-note', (n, e) => { e.stopPropagation(); SkateChat.Notify.toast(n.dataset.note, 'info', 6000); }],
            ['.heart-hint-x', (b, e) => { e.stopPropagation(); SkateSettings.set('heartHintDone', true); Render.programs(); }],
            ['button[data-act]', (btn) => {
                const p = S.filtered[parseInt(btn.dataset.idx)];
                if (!p) return;
                const act = btn.dataset.act;
                if (act === 'fav') Actions.toggleSaved(p);
                else if (act === 'copy') Popover.open(btn, Menus.programCopy(p, btn));
            }]
        ]);
        delegate($('show-more'), [['button[data-more]', (b) => { S.limit = b.dataset.more === 'all' ? Infinity : S.limit + 30; Render.programs(); }]]);

        // ---- Rinks & map ----
        $('btn-rinks-close').onclick = Actions.closeRinks;
        $('btn-share-location').onclick = Actions.useMyLocation;
        $('btn-locator-search').onclick = Actions.searchLocation;
        $('locator-input').onkeydown = e => { if (e.key === 'Enter') Actions.searchLocation(); };
        $('rinks-search').oninput = () => Render.rinks();
        delegate($('rinks-list'), [
            ['[data-loc-filter]', (b) => Actions.filterToRink(b.dataset.locFilter, b.dataset.locName)],
            ['[data-loc-star]', (b) => Actions.toggleMyRink(b.dataset.locStar)]
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
                SkateChat.Notify.toast(mine ? 'Added to your rinks' : 'Removed from your rinks', 'success', 2000);
            }]
        ]);

        // ---- Settings ----
        $('btn-settings').onclick = Actions.openSettings;
        $('btn-settings-close').onclick = () => Modal.close('settings-modal');
        const cal2 = $('set-cal2');
        cal2.checked = cal2Active();
        cal2.onchange = () => {
            SkateSettings.set('cal2', cal2.checked);
            if (cal2.checked && !S.calMode) { S.calMode = true; SkateSettings.set('calMode', true); }
            Modal.close('settings-modal');
            Actions.switchView('programs');
            Render.programs();
            SkateChat.Notify.toast(cal2.checked ? 'Calendar 2.0 is on: Hours, Rinks and Week layouts in the Calendar tab.' : 'Back to the classic week grid.', 'info', 3500);
        };
        $('btn-whatsnew').onclick = () => { Modal.close('settings-modal'); Actions.openWhatsNew(); };
        $('btn-whatsnew-close').onclick = () => Modal.close('whatsnew-modal');
        $('btn-show-qr').onclick = () => Actions.openQr();
        $('btn-qr-close').onclick = () => Modal.close('qr-modal');
        const copySite = () => copyText(CFG.siteUrl, 'Site link copied. Send it anywhere.');
        $('btn-copy-site').onclick = copySite;
        $('btn-qr-copy').onclick = copySite;
        $('btn-start-tour').onclick = () => { Modal.close('settings-modal'); Actions.switchView('programs'); SkateTour.start(); };
        $('btn-play-guide').onclick = () => { Modal.close('settings-modal'); Actions.switchView('programs'); SkateTour.play(); };
        $('btn-save-name').onclick = () => {
            if (SkateChat.setDisplayName($('settings-name').value)) SkateChat.Notify.toast('Name updated', 'success', 2000);
            else SkateChat.Notify.toast('That name will not work. Try another.', 'error', 2500);
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
        $('btn-chat-menu').onclick = e => { e.stopPropagation(); Popover.open($('btn-chat-menu'), Menus.conversation()); };
        $('btn-send').onclick = Actions.sendCurrent;
        $('chat-input').onkeypress = e => { if (e.key === 'Enter') Actions.sendCurrent(); };
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
            ['.member-chip', (chip, e) => { e.stopPropagation(); Popover.open(chip, Menus.user(chip.dataset.pk, chip.dataset.name)); }]
        ]);
        delegate($('chat-messages'), [
            ['a', () => { /* links behave like links */ }],
            ['[data-open-program]', (n) => { Actions.switchView('programs'); Actions.focusProgram(n.dataset.openProgram); }],
            ['[data-open-guide]', (n) => Actions.openGuide(n.dataset.openGuide)],
            ['.reply-ref[data-ref]', (n) => Actions.scrollToMsg(n.dataset.ref)],
            ['.sender[data-pk]', (n, e) => { e.stopPropagation(); Popover.open(n, Menus.user(n.dataset.pk, n.dataset.name)); }],
            ['.chat-msg', (msgEl, e) => {
                const st = SkateChat.getState();
                const m = findMessage(st, msgEl.dataset.local || msgEl.dataset.mid);
                if (!m) return;
                e.stopPropagation();
                Popover.open(msgEl.querySelector('.bubble') || msgEl, Menus.message(m, st));
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
                } catch (err) { SkateChat.Notify.toast(err.message, 'error'); }
            }]
        ]);
        $('btn-create-group').onclick = async () => {
            try {
                const name = $('group-name-input').value.trim();
                const password = $('group-password-input').value.trim() || null;
                if (!name) return SkateChat.Notify.toast('Give your group a name first', 'error', 2000);
                const { invite } = await SkateChat.createGroup({ name, password });
                $('group-name-input').value = ''; $('group-password-input').value = '';
                Modal.close('discover-modal');
                S.chatOpen = true;
                Actions.switchView('chats');
                if (invite) copyText(invite.url, invite.hasPassword
                    ? 'Group created and the invite link copied. Friends will also need the password.'
                    : 'Group created and the invite link copied.');
            } catch (e) { SkateChat.Notify.toast(e.message, 'error'); }
        };
        $('btn-join-link').onclick = () => {
            const raw = $('join-link-input').value.trim();
            if (!raw) return;
            const hashPart = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw;
            const inv = SkateChat.parseInviteHash(hashPart);
            if (!inv) return SkateChat.Notify.toast('That does not look like a valid invite link', 'error');
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

    /* ================= Boot ================= */
    async function init() {
        Render.bootstrap();
        Actions.applyTheme();
        bind();

        // Everyone lands on the schedule (the first tab), on every device.
        // Brand-new visitors get ONE lightweight setup screen (sections +
        // rinks, all skippable); existing users are grandfathered past it.
        // Favorites are loaded here, not in the community boot — the ❤️
        // hearts must work even on a schedule-only (no chat/guides) visit.
        SkateChat.Favorites.load();
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
            rinkFilter: rinkInScope
        });

        try {
            const programs = await SkateAPI.getSkatingPrograms();
            S.programs = programs || [];
            mergeLiveExtras();
            Actions.applyFilters();
            SkateLive.load(S.programs);   // live venue spots (TTL-throttled)
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

    return { init, S, Render, Actions, officialUrl, officialSite, rinkCity };
})();

SkateApp.init();
