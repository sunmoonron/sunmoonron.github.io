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
        paidVisible: !!SkateSettings.get('paidVisible'),
        rinkScope: SkateSettings.get('rinkScope') || 'all',
        sort: SkateSettings.get('sort') || 'time',
        calMode: !!SkateSettings.get('calMode'),
        calWeekOffset: 0,
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
            return hit ? `<span class="tag ${hit.cls}">${hit.label}</span>` : '';
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
    function officialLinkHtml(url, site, cls = 'official-link') {
        return url ? `<a class="${cls}" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Official page — verify the schedule before you go">🏛️ ${escapeHtml(site)} ↗</a>` : '';
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
        return `⛸️ ${P.activity(p)}\n📍 ${P.location(p)}\n🗓️ ${date}${P.time(p) ? ' at ' + fmtClock(P.time(p)) : ''}` +
            (p.Paid ? `\n💲 Paid${p.Price != null ? ' · $' + p.Price : ''}` : (p.PriceNote ? `\nℹ️ ${p.PriceNote}` : '')) +
            (off ? `\n🏛️ Verify: ${off}` : '') +
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
            p.Paid ? `Paid session${p.Price != null ? ` · $${p.Price}` : ''}${p.RegistrationUrl ? ` · Register: ${p.RegistrationUrl}` : ''}` : (p.PriceNote || 'Free drop-in'),
            p.Unverified ? 'UNVERIFIED schedule (scraped) — confirm with the venue' : '',
            off ? `Verify on ${officialSite(p)}: ${off}` : '',
            `Toronto Skating: ${baseUrl()}#p=${P.id(p)}`
        ].filter(Boolean).join('\n');
        return {
            title: `⛸️ ${P.activity(p)} — ${P.location(p)}`,
            start: st.startEpoch, end: st.endEpoch,
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
    function icsText(ev) {
        const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
        return [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Toronto Skating//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
            'BEGIN:VEVENT',
            `UID:${ev.uid}@toronto-skating`,
            `DTSTAMP:${utcStamp(Date.now())}`,
            `DTSTART:${utcStamp(ev.start)}`,
            `DTEND:${utcStamp(ev.end)}`,
            `SUMMARY:${esc(ev.title)}`,
            `LOCATION:${esc(ev.location)}`,
            `DESCRIPTION:${esc(ev.details)}`,
            `URL:${baseUrl()}#p=${ev.uid}`,
            'END:VEVENT', 'END:VCALENDAR'
        ].join('\r\n');
    }
    const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    function downloadIcs(p) {
        const ev = calEvent(p);
        if (!ev) return SkateChat.Notify.toast('This program has no date to add', 'error');
        const ics = icsText(ev);
        if (isIOS()) {
            // iOS hands text/calendar straight to the Calendar app ("Add All");
            // <a download> is a no-op there, doubly so inside the installed app.
            window.location.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
            return;
        }
        const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `skating-${ev.uid}.ics` });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        SkateChat.Notify.toast('Calendar file downloaded — open it to add the session 📆', 'success', 2500);
    }
    function openCalendarLink(p, kind) {
        const ev = calEvent(p);
        if (!ev) return SkateChat.Notify.toast('This program has no date to add', 'error');
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

        Render.calLegend();

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
    /**
     * Upcoming (not-ended) session count at one location key, honouring the
     * Paid toggle — so every count in the UI moves together when Paid flips.
     */
    function upcomingCountFor(key, nowMs = Date.now()) {
        const sp = upcomingSplit(key, nowMs);
        return S.paidVisible ? sp.free + sp.paid : sp.free;
    }

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

    /** "12 sessions" / "3 sessions · 9 paid" / "9 paid" — honest under the Paid toggle. */
    function sessionsLabel(sp) {
        const shown = S.paidVisible ? sp.free + sp.paid : sp.free;
        const n = `${shown} session${shown === 1 ? '' : 's'}`;
        if (S.paidVisible || !sp.paid) return n;
        return shown ? `${n} · ${sp.paid} paid` : `${sp.paid} paid`;
    }

    /* ---------- Active filters as removable pills ---------- */
    const SUB_LABEL = id => (CFG.subTypes.find(x => x.id === id) || {}).label || id;
    const CAT_LABEL = id => (CFG.programTypes.find(x => x.id === id) || {}).label || id;
    const DAY_LABEL = d => d === 'today' ? 'Today' : d === 'tomorrow' ? 'Tomorrow' : d === 'weekend' ? 'Weekend' : (d || '').slice(0, 3);

    /** Everything currently narrowing the list, in pill form (key → label). */
    function activeFilterPills() {
        const pills = [];
        Object.entries(S.types).forEach(([cat, sel]) => {
            const subs = sel === 'all' ? '' : ` · ${sel.map(SUB_LABEL).join(', ')}`;
            pills.push({ key: `type:${cat}`, label: `${CAT_LABEL(cat)}${subs}` });
        });
        S.cities.forEach(c => pills.push({ key: `city:${c}`, label: c }));
        if (S.day) pills.push({ key: 'day', label: DAY_LABEL(S.day) });
        if (S.age !== null) pills.push({ key: 'age', label: `Age ${S.age}` });
        if (S.savedOnly) pills.push({ key: 'saved', label: '❤️ Saved' });
        if (S.nearRink) pills.push({ key: 'near', label: `📍 ${S.nearRink.name}` });
        if (S.paidVisible) pills.push({ key: 'paid', label: '💲 Paid shown' });
        if (S.showPast) pills.push({ key: 'past', label: 'Ended shown' });
        if (S.sort === 'near') pills.push({ key: 'sort', label: 'Nearest first' });
        return pills;
    }

    Render.pills = function () {
        const wrap = $('active-filters');
        wrap.innerHTML = '';
        const mine = (SkateSettings.get('myRinks') || []).length;
        if (mine) {
            // a standing toggle, not a removable pill — regulars flip it daily
            const on = S.rinkScope === 'mine';
            wrap.appendChild(el('button', {
                class: 'pill toggle' + (on ? ' active' : ''), dataset: { pill: 'mine' },
                title: on ? 'Showing only your rinks — tap for every rink' : 'Tap to show only your rinks'
            }, [`⭐ My rinks (${mine})`]));
        }
        const pills = activeFilterPills();
        pills.forEach(pl => wrap.appendChild(el('button', { class: 'pill', dataset: { pill: pl.key }, title: 'Remove this filter' }, [
            pl.label, el('span', { class: 'pill-x', 'aria-hidden': 'true' }, ['✕'])
        ])));
        wrap.classList.toggle('hidden', !wrap.children.length);
        const n = pills.length + (S.rinkScope === 'mine' && mine ? 1 : 0);
        $('filters-count').textContent = String(n);
        $('filters-count').classList.toggle('hidden', !n);
        $('btn-filters').classList.toggle('active', !!n);
        $('btn-week').textContent = S.calMode ? 'List' : 'Week';
        $('btn-week').classList.toggle('active', S.calMode);
    };

    /* ---------- Filters sheet ---------- */
    /** Counts by category / sub-type / city over the whole dataset. */
    function filterFacets() {
        const cats = {}, cities = {};
        let paid = 0;
        S.programs.forEach(p => {
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

    Render.filters = function () {
        const f = filterFacets();
        const body = $('filters-body');
        body.innerHTML = '';
        const section = (title) => { const sec = el('div', { class: 'fsec' }); sec.appendChild(el('h4', {}, [title])); body.appendChild(sec); return sec; };
        const check = (label, on, dataset, cls = '') => {
            const input = el('input', { type: 'checkbox', dataset });
            input.checked = !!on;
            return el('label', { class: 'fcheck' + cls }, [input, el('span', { class: 'fcheck-label' }, [label])]);
        };
        const count = (n) => el('span', { class: 'fcount' }, [String(n)]);
        const chip = (label, on, dataset) => el('button', { class: 'fchip' + (on ? ' active' : ''), dataset }, [label]);

        // TYPE — categories, each expandable into the age groups it actually has
        const t = section('Type');
        CFG.programTypes.forEach(cat => {
            const facet = f.cats[cat.id];
            if (!facet) return;                                     // not in this dataset
            const sel = S.types[cat.id];
            const subsPresent = CFG.subTypes.filter(x => facet.subs[x.id]);
            const row = el('div', { class: 'fcat' + (sel ? ' on' : '') });
            row.appendChild(check(cat.label, !!sel, { type: cat.id }, ' cat'));
            row.appendChild(count(facet.n));
            if (subsPresent.length > 1) {
                const open = !!S.expandedCats[cat.id] || (!!sel && sel !== 'all');
                row.appendChild(el('button', { class: 'fexpand', dataset: { expand: cat.id }, title: open ? 'Hide age groups' : 'Choose age groups' }, [open ? '▴' : '▾']));
                t.appendChild(row);
                const subs = el('div', { class: 'fsubs' + (open ? '' : ' hidden') });
                subsPresent.forEach(x => {
                    const on = sel === 'all' || (Array.isArray(sel) && sel.includes(x.id));
                    const c = check(x.label, !!sel && on, { type: cat.id, sub: x.id });
                    c.appendChild(count(facet.subs[x.id]));
                    subs.appendChild(c);
                });
                t.appendChild(subs);
            } else {
                t.appendChild(row);
            }
        });
        t.appendChild(check('❤️ Only sessions I saved', S.savedOnly, { flag: 'saved' }));

        // WHEN
        const w = section('When');
        const days = el('div', { class: 'fchips' });
        [['', 'Any day'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['weekend', 'Weekend'], ...CFG.days.map(d => [d, d.slice(0, 3)])]
            .forEach(([id, label]) => days.appendChild(chip(label, S.day === id, { day: id })));
        w.appendChild(days);
        w.appendChild(check('Include sessions that already ended', S.showPast, { flag: 'past' }));

        // WHO
        const who = section('Who');
        const ageInput = el('input', { type: 'number', min: '0', max: '120', id: 'f-age', placeholder: 'any age', inputmode: 'numeric' });
        if (S.age !== null) ageInput.value = S.age;
        who.appendChild(el('label', { class: 'fage' }, ['Only sessions open to someone aged ', ageInput]));

        // WHERE
        const where = section('Where');
        const cityRow = el('div', { class: 'fchips' });
        cityKeys(f.cities).forEach(c => cityRow.appendChild(chip(`${c} · ${f.cities[c]}`, S.cities.includes(c), { city: c })));
        where.appendChild(cityRow);
        const mine = (SkateSettings.get('myRinks') || []).length;
        const mineRow = check(`⭐ My rinks only${mine ? ` (${mine})` : ''}`, S.rinkScope === 'mine', { flag: 'mine' });
        mineRow.appendChild(el('button', { class: 'flink', dataset: { open: 'rinks' } }, [mine ? 'Edit' : 'Pick rinks']));
        where.appendChild(mineRow);
        where.appendChild(check(`💲 Show paid venues (${f.paid})`, S.paidVisible, { flag: 'paid' }));

        // ORDER
        const o = section('Order');
        const ord = el('div', { class: 'fchips' });
        CFG.sortOptions.forEach(x => ord.appendChild(chip(x.label, S.sort === x.id, { sort: x.id })));
        o.appendChild(ord);
        if (S.sort === 'near' && !SkateGeo.getUserLocation()) o.appendChild(el('p', { class: 'settings-hint' }, ['Nearest needs your location — set it under Rinks & map.']));

        Render.filtersCount();
    };

    Render.filtersCount = function () {
        const n = computeFiltered().length;
        $('btn-filters-apply').textContent = `Show ${n} session${n === 1 ? '' : 's'}`;
    };

    /** Calendar legend in words: colored dots per type + state samples. */
    Render.calLegend = function () {
        const types = CFG.activityTags.map(t =>
            `<span class="legend-item"><span class="legend-dot ${t.cls}"></span>${escapeHtml(t.label.replace(/^\S+\s/, ''))}</span>`
        ).join('');
        $('cal-legend').innerHTML =
            `<span class="legend-group">${types}</span>` +
            `<span class="legend-group">
                <span class="legend-item"><span class="legend-sample sample-saved"></span>saved</span>
                <span class="legend-item"><span class="legend-sample sample-paid"></span>paid ($)</span>
                <span class="legend-item"><span class="legend-sample sample-cancelled">✕</span>likely cancelled</span>
                <span class="legend-item"><span class="legend-sample sample-warning"></span>service alert</span>
                <span class="legend-item"><span class="legend-sample sample-unverified"></span>unverified</span>
            </span>
            <span class="legend-hint">Tap any session for details &amp; actions.</span>`;
    };

    /**
     * "Next saved session" countdown card — the schedule's answer to a
     * fridge note. Shows the soonest saved session that hasn't ended
     * (live ones first), ticking via the 1-minute refresh.
     */
    Render.savedNext = function () {
        const card = $('saved-next');
        const nowMs = Date.now();
        let best = null, bestSt = null;
        S.programs.forEach(p => {
            if (!SkateChat.Favorites.has(p)) return;
            if (SkateAlerts.isDropped(p)) return;           // the City dropped it — no countdown to nothing
            const st = SkateTime.status(p, nowMs);
            if (st.phase === 'ended' || st.phase === 'undated') return;
            const rank = (st.phase === 'live' ? 0 : 1);
            const bestRank = bestSt ? (bestSt.phase === 'live' ? 0 : 1) : 9;
            if (!best || rank < bestRank || (rank === bestRank && st.startEpoch < bestSt.startEpoch)) {
                best = p; bestSt = st;
            }
        });
        if (!best) { card.classList.add('hidden'); return; }

        const when = bestSt.phase === 'live'
            ? `On the ice now · ${SkateTime.fmtMins(bestSt.minsLeft)} left`
            : bestSt.minsToStart < 24 * 60
                ? `Starts in ${SkateTime.fmtMins(bestSt.minsToStart)}`
                : parseLocalDate(P.dateStr(best)).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + fmtClock(P.time(best));

        card.classList.remove('hidden');
        card.classList.toggle('is-live', bestSt.phase === 'live');
        card.dataset.pid = P.id(best);
        card.innerHTML = `
            <span class="saved-next-heart" aria-hidden="true">♥</span>
            <span class="saved-next-info">
                <span class="saved-next-label">Next saved session</span>
                <span class="saved-next-title">${escapeHtml(P.activity(best))} · ${escapeHtml(P.location(best))}</span>
            </span>
            <span class="saved-next-when">${escapeHtml(when)}</span>`;
    };

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
                    <strong>⚠️ Service alerts last checked ~${hrs}h ago</strong>
                    — the alert checker may be delayed, so a rink could be closed without a banner here.
                    Confirm with the venue before travelling.
                </div>`;
            }
        }

        if (SkateAlerts.loaded && SkateAlerts.liveCheckedAt) {
            const ageMs = now - new Date(SkateAlerts.liveCheckedAt);
            if (ageMs > LIVE_STALE_MS) {
                const hrs = Math.round(ageMs / 3600000);
                wrap.innerHTML += `<div class="alert-banner warning">
                    <strong>⚠️ toronto.ca cross-check last ran ~${hrs}h ago</strong>
                    — a session the City has since dropped could still be listed here. Use the 🏛️ link on a row to verify before travelling.
                </div>`;
            }
        }

        if (!metadata) return;

        if (metadata.lastUpdated) {
            const daysAgo = Math.floor((now - new Date(metadata.lastUpdated)) / 86400000);
            if (daysAgo > 8) {
                wrap.innerHTML += `<div class="alert-banner closed">
                    <strong>⚠️ Schedule data is ${daysAgo} days old.</strong>
                    The auto-updater may be down — sessions shown here could have changed.
                    Tap 🔄 to request a refresh, and double-check with the venue before travelling.
                </div>`;
            }
        }

        Object.entries(metadata.sources || {}).forEach(([key, s]) => {
            if (s.ok !== false) return;
            const label = CFG.sourceInfo[key]?.label || key;
            wrap.innerHTML += `<div class="alert-banner warning">
                <strong>⚠️ ${escapeHtml(label)} feed failed at the last update</strong>
                — its sessions may be missing or stale${s.count ? ` (showing ${s.count} salvaged from the previous run)` : ''}.
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
        Render.savedNext();

        // list ↔ week (the Week button)
        $('calendar-wrap').classList.toggle('hidden', !S.calMode);
        $('program-list').classList.toggle('hidden', S.calMode);
        $('show-more').classList.toggle('hidden', S.calMode);
        if (S.calMode) return Render.calendar();

        const list = $('program-list');
        if (!filtered.length) {
            const paidOnly = !S.paidVisible && S.paidMatching > 0;
            const empty = S.savedOnly ? 'Nothing saved yet — tap ♡ on any session to keep it here.'
                : paidOnly ? `All ${S.paidMatching} matching session${S.paidMatching === 1 ? ' is' : 's are'} at paid venues — switch on "Show paid venues" in Filters.`
                : S.rinkScope === 'mine' ? 'Nothing at your rinks with these filters — tap the ⭐ pill to see every rink.'
                : 'No sessions match. Try fewer filters.';
            list.innerHTML = `<li class="loading">${empty}</li>`;
            Render.showMore(0);
            return;
        }

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
            ? `<button class="btn-more" data-more="1">Show ${Math.min(30, left)} more <span class="btn-more-left">· ${left} left</span></button>`
            : '';
    };

    Render.calendar = function () {
        const res = SkateCalendar.render($('calendar-view'), S.filtered, {
            weekOffset: S.calWeekOffset,
            fmtClock,
            idFor: p => P.id(p),
            isSaved: p => SkateChat.Favorites.has(p),
            alertFor: p => SkateAlerts.forProgram(p),
            statusFor: p => SkateTime.status(p),
            typeFor: p => P.typeCls(p)
        });
        $('cal-label').textContent = `${res.label} · ${res.total} session${res.total === 1 ? '' : 's'}`;
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

        // Service alert verdict for this location (toronto.ca snapshot), or
        // the live-schedule verdict (the City no longer lists this session)
        const alert = SkateAlerts.forProgram(p);
        const off = officialUrl(p);
        let alertHtml = '';
        if (alert && alert.live) {
            alertHtml = `<div class="alert-banner closed live-flag" title="${escapeHtml(alert.text)}">
                <strong>🚫 ${escapeHtml(alert.reason)}:</strong> ${escapeHtml(alert.text)}
                ${off ? `<a class="verify-link" href="${escapeHtml(off)}" target="_blank" rel="noopener">Verify on toronto.ca ↗</a>` : ''}
            </div>`;
        } else if (alert) {
            const closed = alert.level === 'closed';
            const snippet = (alert.text || '').slice(0, 200);
            alertHtml = `<div class="alert-banner ${closed ? 'closed' : 'warning'}" title="${escapeHtml(alert.text || alert.reason)}">
                <strong>${closed ? '🚫 Likely cancelled — rink alert' : '⚠️ Service alert at this location'}:</strong>
                ${escapeHtml(alert.reason)}${snippet ? ` — ${escapeHtml(snippet)}${alert.text.length > 200 ? '…' : ''}` : ''}
            </div>`;
        }

        // Scraped schedules can't be verified against a live feed — say so, loudly.
        const unverifiedHtml = p.Unverified ? `<div class="alert-banner unverified">
                <strong>❓ UNVERIFIED — CALL / CHECK WEBSITE</strong> — this schedule is scraped from the venue's site and there's no live status feed. Confirm before heading out:
                <a href="${escapeHtml(p.InfoUrl || '#')}" target="_blank" rel="noopener">venue website ↗</a>
            </div>` : '';

        // Paid venue extras: gold badge with price + register link; price notes
        // (e.g. "free for Vaughan residents") ride as a small muted badge
        const srcInfo = CFG.sourceInfo[p.Source];
        const paidBadge = p.Paid ? `<span class="paid-badge" title="Paid venue${srcInfo ? ' — ' + escapeHtml(srcInfo.label) : ''}${srcInfo?.note ? '. ' + escapeHtml(srcInfo.note) : ''}">$${p.Price != null ? p.Price : '?'}</span>` : '';
        const noteBadge = p.PriceNote ? `<span class="note-badge" title="${escapeHtml(p.PriceNote)}">${escapeHtml(p.PriceNote)}</span>` : '';
        const registerBtn = (p.Paid && p.RegistrationUrl) ? `<a class="btn-register" href="${escapeHtml(p.RegistrationUrl)}" target="_blank" rel="noopener" title="Opens the venue's registration page">Register ↗</a>` : '';

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
                spotsBadge = '<span class="spots-badge closed-reg" title="The venue hasn\'t opened online registration for this session yet">Registration opens later</span>';
            } else if (live.open != null) {
                spotsBadge = `<span class="spots-badge${live.open <= 20 ? ' low' : ''}" title="Live from the venue's registration system">${live.open}${live.capacity ? '/' + live.capacity : ''} spots left</span>`;
            } else if (live.unlimited && live.status === 'open') {
                spotsBadge = '<span class="spots-badge" title="No capacity limit set by the venue">Registration open</span>';
            }
        }

        // Distance badge once a location is set via Rinks & map
        const km = SkateGeo.distanceForProgram(p);
        const distBadge = km != null ? `<div class="dist-badge">📍 ${SkateGeo.fmtKm(km)}</div>` : '';

        // Per-location footnote (e.g. Don Montgomery's on-site rink-info TV)
        const note = CFG.locationNotes[String(p['Location ID'] ?? '')];
        const noteBtn = note ? `<button class="loc-note" data-note="${escapeHtml(note)}" title="${escapeHtml(note)}" aria-label="Location note">ℹ️</button>` : '';

        const isFavorite = SkateChat.Favorites.has(p);
        const actionHtml = CFG.programActions.map(a => {
            let title = a.title || '', text = a.text || '', extraCls = '';
            if (a.act === 'fav') {
                title = isFavorite ? 'Remove from saved' : 'Save this session';
                text = isFavorite ? '❤️' : '🤍';
                extraCls = isFavorite ? ' active' : '';
            }
            return `<button data-act="${a.act}" data-idx="${idx}" class="${a.cls}${extraCls}" title="${title}">${text}</button>`;
        }).join('');

        const city = P.city(p);
        const cityTag = city !== 'Toronto' ? `<span class="city-tag">${escapeHtml(city)}</span>` : '';
        const locationHtml = location ? `<a href="${mapsUrl(location)}" target="_blank" rel="noopener" class="program-location">📍 ${escapeHtml(location)} ↗</a>${cityTag}${noteBtn} ${officialLinkHtml(off, officialSite(p))}` : '';

        return `
            <li class="program-item${rowStateCls}${p.Paid ? ' is-paid' : ''}${isFavorite ? ' is-saved' : ''}${alert ? (alert.level === 'closed' ? ' has-alert-closed' : ' has-alert') : ''}" data-pid="${pid}">
                <div class="program-header">
                    <div>
                        <div class="program-title">${escapeHtml(activity)}</div>
                        ${locationHtml}
                    </div>
                    <div class="program-meta">
                        ${statusChip}
                        <div class="program-time">${fmtClock(time)}${endTime ? '–' + fmtClock(endTime) : ''}</div>
                        ${distBadge}
                    </div>
                </div>
                ${alertHtml}${unverifiedHtml}
                <div class="program-footer">
                    <div class="program-badges">${P.tagFor(p)} ${paidBadge} ${noteBadge} ${spotsBadge} ${P.ageBadge(p)}</div>
                    <div class="program-actions">${registerBtn}${actionHtml}</div>
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
            el('strong', {}, [c.name + (c.muted ? ' 🔇' : '')]),
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
            else if (f === 'dms') li.textContent = 'No DMs yet — tap someone\'s name in any chat to message them.';
            else {
                li.append(
                    el('p', {}, ['No conversations yet.']),
                    el('button', { class: 'btn-primary btn-small', onclick: () => Modal.open('discover-modal') }, ['＋ Browse rooms'])
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
        $('cf-muted').textContent = `🔇 Muted${mutedThreads ? ` (${mutedThreads})` : ''}`;

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
            const locLink = loc ? `<a href="${mapsUrl(loc)}" target="_blank" rel="noopener">📍 ${escapeHtml(loc)} ↗</a>` : '';
            content = `<strong>⛸️ ${escapeHtml(m.data.activity)}</strong><br>${locLink}<br>🗓️ ${escapeHtml(m.data.date || '')}${m.data.time ? ' • ' + fmtClock(m.data.time) : ''}${m.data.endTime ? '–' + fmtClock(m.data.endTime) : ''}`;
            // Paid heads-up on shared cards (price sanitized — it rode the wire)
            if (m.data.paid) {
                const p = Number(m.data.price);
                const priceTxt = Number.isFinite(p) && p > 0 && p < 1000 ? `$${p % 1 ? p.toFixed(2) : p}` : 'fee applies';
                content += `<br><span class="share-paid-badge" title="This venue charges — check their site for exact rates by age">Paid session · ${priceTxt}</span>`;
            }
            if (m.data.note) content += `<br><span class="share-note">ℹ️ ${escapeHtml(String(m.data.note).slice(0, 120))}</span>`;
            const offUrl = httpOnly(m.data.official);
            if (offUrl) content += `<br><a class="share-official" href="${escapeHtml(offUrl)}" target="_blank" rel="noopener">🏛️ Verify on ${escapeHtml(String(m.data.site || 'official site').slice(0, 30))} ↗</a>`;
            if (m.data.programId) content += `<br><span class="share-open" data-open-program="${escapeHtml(m.data.programId)}">Open in Programs →</span>`;
        } else if (m.type === 'guide' && m.data) {
            const cat = SkateGuides.CATEGORIES[m.data.category];
            content = `<strong>📖 ${escapeHtml(m.data.title)}</strong>` +
                (cat ? `<br><span class="guide-cat">${cat.emoji} ${escapeHtml(cat.name)}</span>` : '') +
                (m.data.excerpt ? `<br><em>“${escapeHtml(m.data.excerpt)}”</em>` : '') +
                `<br><span class="share-open" data-open-guide="${escapeHtml(m.data.guideId || '')}">Read the guide →</span>`;
        }

        const tick = !m.mine ? '' :
            m.status === 'pending' ? '<span class="msg-tick pending" title="Sending…">⏳</span>' :
            m.status === 'failed' ? '<span class="msg-tick failed" title="Not delivered — tap the message to retry">⚠ retry</span>' :
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
            hint.textContent = '🔐 Private message · end-to-end encrypted · never sent to any third party (on-device word filter only)';
            hint.className = 'chat-privacy-hint private';
        } else if (activeGroup && !activeGroup.isPublic) {
            hint.textContent = '🔒 Private group · never sent to any third party (on-device word filter only)';
            hint.className = 'chat-privacy-hint private';
        } else if (activeGroup) {
            hint.textContent = cloud
                ? '🌐 Public room · messages are checked by a third-party profanity filter before sending (switch off in ⚙️ Settings → 🛡️)'
                : '🌐 Public room · on-device word filter only (cloud check is off in ⚙️ Settings)';
            hint.className = 'chat-privacy-hint public';
        } else {
            hint.className = 'chat-privacy-hint hidden';
        }
        if (viewMode === 'dm' && activeDmThread) {
            convKey = 'dm:' + activeDmRecipient;
            $('chat-title').innerHTML = `${hueDot(activeDmRecipient)}${escapeHtml(activeDmThread.name)} <span class="pk-tag" title="Identity tag — same tag = same person, whatever they rename themselves">${shortPk(activeDmRecipient)}</span>`;
            $('chat-status-dot').className = 'status-dot online';
            $('chat-status-text').textContent = SkateChat.Mutes.has(activeDmRecipient) ? 'Muted — you won\'t be pinged' : 'Private message';
            $('chat-online').classList.add('hidden');
            $('members-bar').classList.add('hidden');
            visible = activeDmThread.messages || [];
            msgs.innerHTML = visible.length
                ? visible.map(m => Render.msg(m, true)).join('')
                : '<div class="chat-empty"><p>Start a private conversation — it reaches them even if they\'re offline now.</p></div>';
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
                : '<div class="chat-empty"><p>No messages yet. Say hi! 👋</p></div>';

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
            ml.appendChild(el('span', { class: 'members-solo' }, ['Just you so far — messages wait here for whoever joins']));
            return;
        }
        const shown = membersExpanded ? roster : roster.slice(0, MEMBERS_CAP);
        shown.forEach(r => {
            const chip = el('button', {
                class: 'member-chip' + (r.muted ? ' is-muted' : ''),
                dataset: { pk: r.pubkey, name: r.name },
                title: `${r.name} — message or mute`
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
        $('share-title').textContent = ctx.type === 'guide' ? '📖 Share guide to…' : '📤 Share program to…';
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
        const label = /^my location$/i.test(w.label || '') ? '📍 near you' : (w.label || '');
        chip.textContent = `${w.emoji} ${w.temp}° · ${label.length > 18 ? label.slice(0, 17) + '…' : label}`;
        chip.title = `${w.text} in ${w.label}: ${w.temp}°C, feels like ${w.feels}°C — tap to pick another spot (Open-Meteo)`;
    };

    /* ---------- Rinks & map: one view for the map, "near me" and your rinks ---------- */
    Render.rinks = function () {
        const user = SkateGeo.getUserLocation();
        $('locator-status').textContent = user ? `Distances from: ${user.label}` : 'Use your location or type an address for distances — or just browse.';
        const wrap = $('rinks-list');
        wrap.innerHTML = '';
        if (!SkateGeo.loaded || !SkateGeo.rinks.length) {
            wrap.appendChild(el('p', { class: 'settings-hint' }, ['Rink list still loading — one second.']));
            return;
        }
        const q = $('rinks-search').value.trim().toLowerCase();
        const mine = new Set(SkateSettings.get('myRinks') || []);
        let rows = SkateGeo.rinks.map(r => ({ ...r, km: user && r.lat != null ? SkateGeo.distanceKm(user, { lat: r.lat, lng: r.lng }) : null }));
        if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || (r.district || '').toLowerCase().includes(q));
        rows.sort((a, b) =>
            (mine.has(String(b.locationid)) - mine.has(String(a.locationid))) ||   // yours first
            ((a.km ?? Infinity) - (b.km ?? Infinity)) ||                            // then nearest
            a.name.localeCompare(b.name));                                          // then A–Z
        rows.slice(0, 60).forEach(r => {
            const key = String(r.locationid);
            const sp = upcomingSplit(key);
            const sessions = S.paidVisible ? sp.free + sp.paid : sp.free;
            const alerts = SkateAlerts.forLocation(key);
            const starred = mine.has(key);
            const meta = [
                r.km != null ? SkateGeo.fmtKm(r.km) : null,
                r.district || null,
                (r.kinds || []).map(k => k === 'indoor' ? 'indoor' : 'outdoor').join(' + ') || null,
                sessions ? `${sessions} upcoming` : (sp.paid ? `${sp.paid} paid` : 'no drop-ins listed')
            ].filter(Boolean).join(' · ');
            const row = el('div', { class: 'rink-row' + (starred ? ' starred' : '') });
            row.appendChild(el('div', { class: 'rink-info' }, [
                el('strong', {}, [r.name, ...(r.paid ? [' 💲'] : []),
                    ...(alerts.length ? [el('span', { class: 'locator-alert', title: alerts.map(a => a.Reason).join(', ') }, [' ⚠️'])] : [])]),
                el('span', { class: 'rink-meta' }, [meta])
            ]));
            row.appendChild(el('div', { class: 'rink-actions' }, [
                el('button', { class: 'btn-small', dataset: { locFilter: key, locName: r.name }, title: 'Show only this rink\'s sessions' }, ['Sessions']),
                el('button', { class: 'btn-small star' + (starred ? ' starred' : ''), dataset: { locStar: key }, title: starred ? 'Remove from my rinks' : 'Add to my rinks' }, [starred ? '★' : '☆'])
            ]));
            wrap.appendChild(row);
        });
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
            $('guides-list').innerHTML = '<div class="chat-empty"><p>No guides here yet — be the first to write one! ✍️</p></div>';
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
                <button class="btn-guide-vote big ${voted ? 'voted' : ''}" data-vote="${g.id}" title="${voted ? 'Remove your vote' : 'Vote useful'}">⛸️ Useful (${g.votes})</button>
                <button data-guide-copy="${g.id}" title="Copy a link to this guide">🔗 Copy link</button>
                <button data-guide-share="${g.id}" title="Share this guide (or a highlighted part) into a chat">📤 Share to chat</button>
            </div>
            <p class="guides-sub">Tip: highlight a sentence before hitting Share to quote just that part. 🔍</p>`;

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
            : '<li class="comment-none">No comments yet — start the thread! 💬</li>';
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
                        if (inv) copyText(inv.url, inv.hasPassword ? 'Invite copied — they\'ll also need the password 🔐' : 'Invite link copied! 🔗');
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
                { ...A('copyLink'), onClick: () => copyText(`${baseUrl()}#p=${P.id(p)}`, 'Link copied! 🔗') },
                { ...A('addCalendar'), onClick: () => {
                    // second-level popover on the same anchor (Popover.close ran first)
                    const at = anchor || document.querySelector(`.program-item[data-pid="${P.id(p)}"] .btn-copy`) || document.body;
                    Popover.open(at, Menus.calendar(p));
                } }
            ];
            const off = officialUrl(p);
            if (off) items.push({ ...A('openOfficial', { site: officialSite(p) }), onClick: () => window.open(off, '_blank', 'noopener') });
            // Share rides the community stack — only offered when Chats are on
            if (SkateSettings.get('showChats') !== false) {
                items.push({ label: '📤 Share to chat…', onClick: () => Actions.openSharePicker({ type: 'program', payload: p }) });
            }
            return items;
        },

        /** Add-to-calendar targets — each opens the calendar app with the event filled in. */
        calendar(p) {
            return [
                { ...A('calGoogle'),  onClick: () => openCalendarLink(p, 'google') },
                { ...A('calOutlook'), onClick: () => openCalendarLink(p, 'outlook') },
                { ...A('calIcs'),     onClick: () => downloadIcs(p) }
            ];
        },

        /** Status line: freshness details + refresh. */
        status() {
            const meta = SkateAPI.getMetadata();
            const fmt = x => x ? new Date(x).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
            const st = SkateAlerts.liveStats;
            const items = [
                { label: `Schedule data: ${fmt(meta?.lastUpdated)}`, onClick: () => {} },
                { label: `Rink alerts checked: ${fmt(SkateAlerts.checkedAt)}`, onClick: () => {} },
                { label: `toronto.ca cross-check: ${fmt(SkateAlerts.liveCheckedAt)}${st ? ` · ${st.missing} dropped by the City` : ''}`, onClick: () => {} },
                { label: '🔄 Refresh now', onClick: () => Actions.refreshPrograms() }
            ];
            if (!S.paidVisible && S.paidMatching) items.push({ label: `💲 Show ${S.paidMatching} paid sessions`, onClick: () => Actions.setFlag('paid', true) });
            return items;
        },

        /** Weather chip: current reading + the spot picker. */
        weather() {
            const w = SkateWeather.current;
            const cur = SkateWeather.selectedId();
            const user = SkateGeo.getUserLocation();
            const items = [];
            if (w) items.push({ label: `${w.emoji} ${w.text} · ${w.temp}°C, feels ${w.feels}°C (Open-Meteo)`, onClick: () => SkateWeather.load(true) });
            items.push({ label: `${cur === 'auto' ? '✓ ' : ''}📍 ${user ? user.label : 'Toronto (set 📍 via Near me)'}`, onClick: () => Actions.pickWeatherSpot('auto') });
            SkateWeather.spots().forEach(sp => items.push({ label: `${cur === sp.id ? '✓ ' : '\u2007\u2007'}${sp.label}`, onClick: () => Actions.pickWeatherSpot(sp.id) }));
            return items;
        },

        /** Tapping a session block in the week calendar. */
        calBlock(p, anchor = null) {
            const fav = SkateChat.Favorites.has(p);
            const items = [
                { label: fav ? '💔 Remove from saved' : '❤️ Save this session', onClick: () => { SkateChat.Favorites.toggle(p); Render.programs(); } },
                { label: '📋 Show in list', onClick: () => {
                    S.calMode = false;
                    SkateSettings.set('calMode', false);
                    Actions.focusProgram(P.id(p));
                } }
            ];
            if (p.Paid && p.RegistrationUrl) {
                items.push({ label: '🎟 Register on venue site ↗', onClick: () => window.open(p.RegistrationUrl, '_blank', 'noopener') });
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
    Actions.setDay = function (d) { S.day = d || ''; filtersChanged(); };
    Actions.setAge = function (v) { const n = parseInt(v, 10); S.age = Number.isFinite(n) ? n : null; filtersChanged(); };
    Actions.setSort = function (id) {
        S.sort = id;
        if (id === 'near' && !SkateGeo.getUserLocation()) {
            Modal.close('filters-modal');
            SkateChat.Notify.toast('Nearest first needs your location — set it here', 'info', 3000);
            Actions.openRinks();
        }
        filtersChanged();
    };
    /** saved / past / mine / paid switches (Filters sheet + status popover + pills). */
    Actions.setFlag = function (flag, on) {
        if (flag === 'saved') S.savedOnly = !!on;
        else if (flag === 'past') S.showPast = !!on;
        else if (flag === 'paid') S.paidVisible = !!on;
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
        S.expandedCats = {};
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
        else if (key === 'sort') S.sort = 'time';
        filtersChanged();
    };
    Actions.toggleWeek = function () {
        S.calMode = !S.calMode;
        SkateSettings.set('calMode', S.calMode);
        Render.programs();
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
        if (idx === -1) return SkateChat.Notify.toast('That session isn\'t in the current dataset anymore', 'error');
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
            SkateChat.Notify.toast(`${what || 'That rink'} only has paid sessions — Paid turned on so they show 💲`, 'info', 4000);
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
            SkateChat.Notify.toast('Map couldn\'t load — the rink list still works', 'error');
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
        btn.disabled = true; btn.textContent = '📍 Locating…';
        try {
            const loc = await SkateGeo.locateMe();
            SkateGeo.setUserLocation(loc);
            locationChanged();
        } catch (e) {
            $('locator-status').textContent = e.message;
        }
        btn.disabled = false; btn.textContent = '📍 Use my location';
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
        SkateChat.Notify.toast(`Showing only ${name} — tap the 📍 pill to clear`, 'info', 3500);
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

    /** First-visit setup still unanswered? (Same condition maybeShowSetup uses.) */
    const setupPending = () =>
        !SkateSettings.get('setupDone') && !SkateSettings.get('experience') && !SkateSettings.get('displayName');

    /**
     * Community boots only when a section is on AND the visitor has had
     * their say — a brand-new visitor mid-setup must not open relay
     * connections that setup is about to decline. (Deep links that need
     * chat immediately call bootCommunity() directly and skip this gate.)
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
            SkateChat.Notify.toast(`${visKey === 'showGuides' ? '📖 Guides' : '💬 Chats'} re-enabled — hide it again in ⚙️ Settings`, 'info', 3500);
        }
        // If the first-visit setup is still on screen (deep link on a brand-new
        // install), tick its box too so finishing setup doesn't undo the link.
        if (!SkateSettings.get('setupDone')) {
            const box = $(visKey === 'showGuides' ? 'setup-guides' : 'setup-chats');
            if (box) box.checked = true;
        }
    };

    Actions.maybeShowSetup = function () {
        if (SkateSettings.get('setupDone')) return;
        // Existing users (already chose an experience or renamed themselves)
        // are grandfathered — no surprise popup on a site they already use.
        if (SkateSettings.get('experience') || SkateSettings.get('displayName')) {
            SkateSettings.set('setupDone', true);
            return;
        }
        // Community is OPT-IN for brand-new visitors: boxes start unchecked,
        // so completing (or dismissing) setup without touching them gives a
        // schedule-only site — zero relay connections until they choose.
        $('setup-guides').checked = false;
        $('setup-chats').checked = false;
        Modal.open('setup-modal');
    };

    /** Persist the setup choices; safe to call twice (overlay + button). */
    Actions.finishSetup = function () {
        if (SkateSettings.get('setupDone')) return;
        SkateSettings.set('showGuides', $('setup-guides').checked);
        SkateSettings.set('showChats', $('setup-chats').checked);
        SkateSettings.set('setupDone', true);
        Modal.close('setup-modal');
        Actions.applyVisibility();
        // Brand-new visitor: run the 20-second spotlight tour right away —
        // its Skip button is front and centre, so it costs one tap at most.
        if (!SkateSettings.get('tourDone')) {
            setTimeout(() => SkateTour.start(), 350);
        }
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
            $('qr-holder').innerHTML = '<p class="settings-hint">Could not build the QR — the Copy link button still works.</p>';
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
        const kinds = (r.kinds || []).map(k => k === 'indoor' ? '🏠 indoor' : '🌳 outdoor').join(' · ');
        const offR = officialUrlForRink(r);
        const sessionsTxt = sessions ? `${sessions} upcoming session${sessions === 1 ? '' : 's'}`
            : (sp.paid ? `${sp.paid} paid session${sp.paid === 1 ? '' : 's'} (Paid toggle off)` : 'no drop-ins listed');
        return `<div class="map-pop">
            <strong>${escapeHtml(r.name)}</strong>
            <span class="map-pop-meta">${kinds}${r.paid ? ' · 💲 paid' : ''}${km != null ? ` · ${SkateGeo.fmtKm(km)}` : ''}${offR ? ` · <a href="${escapeHtml(offR)}" target="_blank" rel="noopener">🏛️ official ↗</a>` : ''}</span>
            <span class="map-pop-meta">${sessionsTxt}${alerts.length ? ' · <span class="map-pop-alert">⚠️ service alert</span>' : ''}</span>
            <span class="map-pop-actions">
                ${(sessions || sp.paid) ? `<button class="btn-small" data-map-sessions="${escapeHtml(key)}" data-map-name="${escapeHtml(r.name)}">Show sessions</button>` : ''}
                <button class="btn-small${mine ? ' starred' : ''}" data-map-star="${escapeHtml(key)}">${mine ? '★ Mine' : '☆ Add to my rinks'}</button>
            </span>
        </div>`;
    }

    Actions.openWhatsNew = function () {
        Render.whatsNew();
        SkateSettings.set('lastSeenVersion', CFG.version);
        $('settings-dot').classList.add('hidden');
        Modal.open('whatsnew-modal');
    };

    /** v3.2: the new-vs-regular question was cut — every gate just continues. */
    Actions.ensureExperience = function (cont) { return cont(); };

    Actions.openGuide = function (id) {
        Actions.ensureSectionVisible('showGuides');
        Actions.switchView('guides');
        const g = SkateGuides.get(id);
        if (!g) {
            S.pendingGuideOpen = id;
            if (SkateGuides.loaded) SkateChat.Notify.toast('Hmm, that guide isn\'t on the relays (yet?)', 'info', 3000);
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
            if (!ok) SkateChat.Notify.toast('Vote didn\'t reach the relays — try again', 'error');
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
        btn.disabled = true; btn.textContent = '⛏️';
        try {
            const ok = await SkateGuides.comment(S.activeGuideId, text, identity(), S.guideReply?.id || null);
            if (ok) { $('guide-comment-input').value = ''; Actions.clearGuideReply(); Render.guideDetail(); }
            else SkateChat.Notify.toast('Comment didn\'t reach the relays', 'error');
        } catch (e) { SkateChat.Notify.toast(e.message, 'error'); }
        btn.disabled = false; btn.textContent = '➤';
    };

    Actions.submitGuide = async function () {
        const btn = $('btn-guide-submit');
        btn.disabled = true; btn.textContent = 'Proving you\'re human ⛏️…';
        try {
            const ok = await SkateGuides.postGuide({
                title: $('guide-title-input').value,
                category: $('guide-cat-input').value,
                body: $('guide-body-input').value
            }, identity());
            if (ok) {
                SkateChat.Notify.toast('Guide published! 📖', 'success');
                $('guide-title-input').value = ''; $('guide-body-input').value = '';
                $('guide-write').classList.add('hidden');
                $('guides-home').classList.remove('hidden');
                Render.guides();
            } else SkateChat.Notify.toast('Relays didn\'t accept it — try again', 'error');
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
        $('btn-play-guide').textContent = `▶️ Watch the ${SkateTour.duration()}-second guide`;
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
                SkateChat.Notify.toast('Schedule, alerts & spots refreshed ✓', 'success', 2000);
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
        if (meta) meta.content = dark ? '#0e141b' : '#2f9fc4';
    };
    if (systemDark?.addEventListener) {
        systemDark.addEventListener('change', () => { if (themeSetting() === 'system') Actions.applyTheme(); });
    }

    /** Silent full data reload (programs + alerts + spots) — shared by the
     *  Refresh button and the resume-from-background path. */
    Actions.reloadData = async function () {
        SkateAPI._skatingPrograms = null;
        S.programs = (await SkateAPI.getSkatingPrograms(true)) || [];   // force: bypass HTTP cache
        SkateAlerts.load(true);             // force (still ≥60s-gapped internally)
        SkateLive.load(S.programs, true);
        Actions.applyFilters(true);
    };

    Actions.refreshPrograms = async function () {
        $('status-data').textContent = 'Refreshing…';
        try {
            await Actions.reloadData();
            // The success/failure story belongs to the city-refresh request —
            // no premature "reloaded!" that survives a cancelled confirm.
            const res = await SkateRefresh.requestCityRefresh();   // toasts on queued/failed itself
            if (res === 'cancelled') {
                SkateChat.Notify.toast('No city refresh requested — showing the latest published schedule', 'info', 2500);
            }
        } catch (e) { SkateChat.Notify.toast('Refresh failed: ' + e.message, 'error'); }
        finally { Render.status(); }
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
        $('btn-week').onclick = Actions.toggleWeek;

        // ---- Pills ----
        delegate($('active-filters'), [['.pill', (b) => Actions.removePill(b.dataset.pill)]]);

        // ---- Status line + weather ----
        $('status-data').onclick = (e) => { e.stopPropagation(); Popover.open($('status-data'), Menus.status()); };
        $('weather-chip').onclick = (e) => { e.stopPropagation(); Popover.open($('weather-chip'), Menus.weather()); };
        $('saved-next').onclick = () => {
            const pid = $('saved-next').dataset.pid;
            if (pid) Actions.focusProgram(pid);
        };

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
            ['.fexpand', (b) => {
                S.expandedCats[b.dataset.expand] = !S.expandedCats[b.dataset.expand];
                Render.filters();
            }],
            ['.fchip[data-day]', (b) => Actions.setDay(b.dataset.day)],
            ['.fchip[data-city]', (b) => Actions.toggleCity(b.dataset.city)],
            ['.fchip[data-sort]', (b) => Actions.setSort(b.dataset.sort)],
            ['.flink[data-open]', () => { Modal.close('filters-modal'); Actions.openRinks(); }]
        ]);

        // ---- Week calendar ----
        $('btn-cal-prev').onclick = () => { S.calWeekOffset--; Render.calendar(); };
        $('btn-cal-next').onclick = () => { S.calWeekOffset++; Render.calendar(); };
        $('btn-cal-today').onclick = () => { S.calWeekOffset = 0; Render.calendar(); };
        delegate($('calendar-view'), [
            ['.cal-block', (block, e) => {
                e.stopPropagation();
                const p = S.filtered.find(x => P.id(x) === block.dataset.pid);
                if (p) Popover.open(block, Menus.calBlock(p, block));
            }]
        ]);

        // ---- List rows + show more ----
        delegate($('program-list'), [
            ['.loc-note', (n, e) => { e.stopPropagation(); SkateChat.Notify.toast(n.dataset.note, 'info', 6000); }],
            ['button[data-act]', (btn) => {
                const p = S.filtered[parseInt(btn.dataset.idx)];
                if (!p) return;
                const act = btn.dataset.act;
                if (act === 'fav') { SkateChat.Favorites.toggle(p); Render.programs(); }
                else if (act === 'copy') Popover.open(btn, Menus.programCopy(p, btn));
            }]
        ]);
        delegate($('show-more'), [['button[data-more]', () => { S.limit += 30; Render.programs(); }]]);

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
        delegate($('map-filter-seg'), [
            ['button[data-mapfilter]', (b) => SkateMap.setFilter(b.dataset.mapfilter)]
        ]);
        // popup buttons render inside the Leaflet container → one delegate
        delegate($('map-canvas'), [
            ['[data-map-sessions]', (b) => Actions.filterToRink(b.dataset.mapSessions, b.dataset.mapName)],
            ['[data-map-star]', (b) => {
                Actions.toggleMyRink(b.dataset.mapStar);
                const mine = (SkateSettings.get('myRinks') || []).includes(b.dataset.mapStar);
                SkateChat.Notify.toast(mine ? 'Added to My rinks ⭐' : 'Removed from My rinks', 'success', 2000);
            }]
        ]);

        // ---- Settings ----
        $('btn-settings').onclick = Actions.openSettings;
        $('btn-settings-close').onclick = () => Modal.close('settings-modal');
        $('btn-whatsnew').onclick = () => { Modal.close('settings-modal'); Actions.openWhatsNew(); };
        $('btn-whatsnew-close').onclick = () => Modal.close('whatsnew-modal');
        $('btn-show-qr').onclick = () => Actions.openQr();
        $('btn-qr-close').onclick = () => Modal.close('qr-modal');
        const copySite = () => copyText(CFG.siteUrl, 'Site link copied — send it anywhere 🔗');
        $('btn-copy-site').onclick = copySite;
        $('btn-qr-copy').onclick = copySite;
        $('btn-start-tour').onclick = () => { Modal.close('settings-modal'); Actions.switchView('programs'); SkateTour.start(); };
        $('btn-play-guide').onclick = () => { Modal.close('settings-modal'); Actions.switchView('programs'); SkateTour.play(); };
        $('btn-save-name').onclick = () => {
            if (SkateChat.setDisplayName($('settings-name').value)) SkateChat.Notify.toast('Name updated ✓', 'success', 2000);
            else SkateChat.Notify.toast('That name won\'t work — try another', 'error', 2500);
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

        // ---- First-visit setup ----
        $('setup-done').onclick = Actions.finishSetup;
        $('setup-nearest').onclick = async () => {
            const btn = $('setup-nearest');
            btn.disabled = true; btn.textContent = '📍 Locating…';
            try {
                const loc = await SkateGeo.locateMe();
                SkateGeo.setUserLocation(loc);
                S.sort = 'near';
                SkateSettings.set('sort', 'near');
                $('setup-rink-status').textContent = '✓ Got it — sessions will sort by distance from you.';
                Actions.applyFilters(true);
            } catch (e) {
                $('setup-rink-status').textContent = e.message;
            }
            btn.disabled = false; btn.textContent = '📍 Rinks near me';
        };
        $('setup-pick').onclick = () => { Actions.finishSetup(); Actions.openRinks(); };

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
                if (!name) return SkateChat.Notify.toast('Give your group a name', 'error', 2000);
                const { invite } = await SkateChat.createGroup({ name, password });
                $('group-name-input').value = ''; $('group-password-input').value = '';
                Modal.close('discover-modal');
                S.chatOpen = true;
                Actions.switchView('chats');
                if (invite) copyText(invite.url, invite.hasPassword
                    ? 'Group created — invite link copied. Friends will also need the password 🔐'
                    : 'Group created — invite link copied! 🔗');
            } catch (e) { SkateChat.Notify.toast(e.message, 'error'); }
        };
        $('btn-join-link').onclick = () => {
            const raw = $('join-link-input').value.trim();
            if (!raw) return;
            const hashPart = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw;
            const inv = SkateChat.parseInviteHash(hashPart);
            if (!inv) return SkateChat.Notify.toast('That doesn\'t look like a valid invite link', 'error');
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
            ['[data-guide-copy]', (n) => copyText(`${baseUrl()}#guide=${n.dataset.guideCopy}`, 'Guide link copied! 🔗')],
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
            if (id === 'setup-modal') Actions.finishSetup();
        });

        // Keyboard: 1-N switch views, Esc walks back (popover → modal → conversation)
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                if (Popover.isOpen()) return Popover.close();
                const modal = Modal.any();
                if (modal) {
                    modal.classList.add('hidden');
                    if (modal.id === 'invite-modal') { S.pendingInvite = null; Actions.clearHash(); }
                    if (modal.id === 'setup-modal') Actions.finishSetup();
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

    /* ================= Boot ================= */
    async function init() {
        Render.bootstrap();
        Actions.applyTheme();
        bind();

        // Everyone lands on the schedule (the first tab), on every device.
        // Brand-new visitors get ONE lightweight setup screen (sections +
        // rinks, all skippable); existing users are grandfathered past it.
        // The experience question stays lazy via ensureExperience.
        // Favorites are loaded here, not in the community boot — the ❤️
        // hearts must work even on a schedule-only (no chat/guides) visit.
        SkateChat.Favorites.load();
        Actions.applyVisibility();   // also kicks off bootCommunity() if a section is visible
        Actions.maybeShowSetup();
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
        SkateAlerts.onUpdate(() => { if (S.programs.length) Render.programs(); });
        SkateLive.onUpdate(() => { if (S.programs.length) Render.programs(); });
        SkateWeather.onUpdate(Render.weather);

        // Map popups pull their content/actions from app-side data
        SkateMap.configure({
            popupHtml: mapPopupHtml,
            userPoint: () => SkateGeo.getUserLocation()
        });

        try {
            const programs = await SkateAPI.getSkatingPrograms();
            S.programs = programs || [];
            Actions.applyFilters();
            SkateLive.load(S.programs);   // live venue spots (TTL-throttled)
            if (S.pendingProgramFocus) { Actions.focusProgram(S.pendingProgramFocus); S.pendingProgramFocus = null; }
        } catch (e) {
            $('program-list').innerHTML = '<li class="loading">Could not load programs 😕 — pull to refresh or try again later.</li>';
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

    return { init, S, Render, Actions, officialUrl, officialSite };
})();

SkateApp.init();
