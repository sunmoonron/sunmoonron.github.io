/**
 * SkateCalendar2 — the experimental calendar (Settings → Display →
 * "Calendar 2.0"): a day planner anyone can read.
 *
 * Pick a day on the strip. The day is Morning / Afternoon / Evening and
 * every session is one plain line: the time first, the rink, then kind ·
 * ages · price, with a heart to save it. No bars, no grid, no cursor —
 * the way a timetable is pinned up in a community-centre lobby. "By rink"
 * groups the same lines under each rink instead (your rinks first, the
 * nearest next). "By distance" (v3.12) groups them into bands around the
 * reader's spot: within 2 km, 2 to 5, 5 to 10, 10 to 20, farther; a row of
 * chips above it sets the "Within N km" filter. On wide screens the parts
 * of the day, or the bands, sit side by side. Today's ended sessions fold
 * away behind "Show N ended" so the reader lands on what is next.
 *
 * Pure renderer with the same contract as SkateCalendar. Clicks are
 * delegated in app.js: `.cal-block[data-pid]` opens the popover, and
 * `data-cal2-day`, `data-cal2-by`, `data-cal2-ended`, `data-cal2-fav`
 * carry the day strip, the By time / By rink / By distance switch, the
 * ended fold and the heart; `data-cal2-radius`, `data-cal2-locate` and
 * `data-cal2-place` belong to the by-distance view.
 */
window.SkateCalendar2 = (() => {
    'use strict';

    const { el } = window.SkateUI;
    const T = window.SkateTime;

    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const PARTS = [
        { id: 'morning',   label: 'Morning',   emoji: '🌅', from: 0,       to: 12 * 60 },
        { id: 'afternoon', label: 'Afternoon', emoji: '☀️', from: 12 * 60, to: 17 * 60 },
        { id: 'evening',   label: 'Evening',   emoji: '🌙', from: 17 * 60, to: 24 * 60 }
    ];

    /* ---- small helpers ---- */
    const mins = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
    const dur = (p) => { const a = mins(p['Start Time']), b = mins(p['End Time']); return a == null || b == null ? 0 : ((b - a) + 1440) % 1440; };
    const fmtDur = (d) => !d ? '' : d % 60 === 0 ? `${d / 60} h` : d > 60 ? `${(d / 60).toFixed(1).replace(/\.0$/, '')} h` : `${d} min`;
    const dateKeyOf = (p) => String(p['Start Date Time'] || p['Start Date'] || '').slice(0, 10);
    const byStart = (x, y) => ((mins(x['Start Time']) ?? 0) - (mins(y['Start Time']) ?? 0)) || (x.LocationName || '').localeCompare(y.LocationName || '');
    function longDate(key) {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }

    /** State classes shared with the classic grid (colours, saved, alerts, live…). */
    function stateCls(p, opts) {
        let cls = '';
        const type = opts.typeFor && opts.typeFor(p);
        if (type) cls += ` cal-type-${type}`;
        if (p.Paid) cls += ' cal-paid';
        if (opts.isSaved(p)) cls += ' cal-saved';
        const a = opts.alertFor(p);
        if (a && a.level !== 'note') cls += a.level === 'closed' ? ' cal-closed' : ' cal-warning';   // a grey note is not an alert on this session
        const st = opts.statusFor(p);
        if (st.phase === 'live') cls += ' cal-live';
        else if (st.phase === 'soon') cls += ' cal-soon';
        else if (st.phase === 'ended') cls += ' cal-ended';
        if (p.Unverified) cls += ' cal-unverified';
        return cls;
    }

    /** What a set of sessions shows, for the legend. */
    function collect(list, opts) {
        const types = new Set(), states = { saved: false, paid: false, closed: false, warning: false, unverified: false };
        list.forEach(p => {
            const t = opts.typeFor && opts.typeFor(p);
            if (t) types.add(t);
            if (p.Paid) states.paid = true;
            if (p.Unverified) states.unverified = true;
            if (opts.isSaved(p)) states.saved = true;
            const a = opts.alertFor(p);
            if (a && a.level !== 'note') states[a.level === 'closed' ? 'closed' : 'warning'] = true;
        });
        return { types: [...types], states };
    }

    const tip = (p, opts) => {
        const a = opts.alertFor(p);
        return `${p.Activity || 'Skating'} · ${p.LocationName || ''} · ${opts.fmtClock(p['Start Time'] || '')}${p['End Time'] ? '–' + opts.fmtClock(p['End Time']) : ''}`
            + (dur(p) ? ` (${fmtDur(dur(p))})` : '') + (p.Paid ? ' · paid' : '')
            + (a && a.level !== 'note' ? (a.level === 'closed' ? ' · likely cancelled (rink alert)' : ' · service alert at this rink') : '')
            + (p.Unverified ? ' · unverified schedule' : '');
    };

    function dayStrip(weekStartKey, counts, selected, todayKey) {
        const strip = el('div', { class: 'cal-days c2-days', role: 'tablist', 'aria-label': 'Days of this week' });
        for (let i = 0; i < 7; i++) {
            const key = T.addDays(weekStartKey, i);
            const n = counts[key] || 0;
            strip.appendChild(el('button', {
                class: 'cal-daychip' + (key === todayKey ? ' today' : '') + (key === selected ? ' in-view' : '') + (n ? '' : ' empty'),
                dataset: { cal2Day: key }, role: 'tab', 'aria-selected': key === selected ? 'true' : 'false',
                title: `${n} session${n === 1 ? '' : 's'}`
            }, [
                el('span', { class: 'cal-daychip-name' }, [DAY_LABELS[i]]),
                el('span', { class: 'cal-daychip-num' }, [key.slice(8).replace(/^0/, '')]),
                el('span', { class: 'cal-daychip-count' }, [String(n)])
            ]));
        }
        return strip;
    }

    /** One session as one line: time · name · kind, ages, price · state, and a heart. */
    function line(p, opts, nameIsRink) {
        const st = opts.statusFor(p);
        const saved = opts.isSaved(p);
        const alert = opts.alertFor(p);
        const kindCls = (opts.typeFor && opts.typeFor(p)) || '';
        const state = alert && alert.level === 'closed' ? { cls: ' alert', txt: 'Likely cancelled' }
            : st.phase === 'live' ? { cls: ' live', txt: `On now · ${opts.fmtMins(st.minsLeft)} left` }
            : st.phase === 'soon' ? { cls: ' soon', txt: `In ${opts.fmtMins(st.minsToStart)}` }
            : st.phase === 'ended' ? { cls: ' ended', txt: 'Ended' }
            : alert && alert.level !== 'note' ? { cls: ' warn', txt: 'Rink alert' } : null;
        const km = nameIsRink ? opts.distanceFor(p) : null;
        const meta = [
            el('span', { class: 'c2-kind ' + kindCls }, [opts.kindLabel(p)]),
            ` · ${opts.ageText(p)} · `,
            el('span', { class: p.Paid ? 'c2-paid' : 'c2-free' }, [p.Paid ? (opts.priceLabel ? opts.priceLabel(p) : `$${opts.fmtPrice(p.Price)}`) : 'Free']),
            ...(km != null ? [` · ${opts.fmtKm(km)}`] : []),
            ...(p.Unverified ? [' · unverified'] : [])
        ];
        const row = el('div', { class: 'c2-line' + stateCls(p, opts) });
        row.appendChild(el('button', { class: 'cal-block c2-line-main' + (kindCls ? ` cal-type-${kindCls}` : ''), dataset: { pid: opts.idFor(p) }, title: tip(p, opts) }, [
            el('span', { class: 'c2-line-time' }, [
                el('b', {}, [opts.fmtClock(p['Start Time'] || '')]),
                el('small', {}, [p['End Time'] ? `to ${opts.fmtClock(p['End Time'])}` : ''])
            ]),
            el('span', { class: 'c2-line-body' }, [
                el('span', { class: 'c2-line-top' }, [
                    el('span', { class: 'c2-line-name' }, [nameIsRink ? (p.LocationName || '') : (p.Activity || 'Skating')]),
                    ...(state ? [el('span', { class: 'c2-line-state' + state.cls }, [state.txt])] : [])
                ]),
                el('span', { class: 'c2-line-meta' }, meta)
            ])
        ]));
        row.appendChild(el('button', {
            class: 'c2-line-fav' + (saved ? ' active' : ''), dataset: { cal2Fav: opts.idFor(p) },
            'aria-label': saved ? 'Remove from saved' : 'Save this session', title: saved ? 'Remove from saved' : 'Save this session'
        }, [saved ? '♥' : '♡']));
        return row;
    }

    const foldBtn = (n, shown) => el('button', { class: 'c2-ended-fold', dataset: { cal2Ended: '1' } }, [shown ? `Hide the ${n} ended` : `Show ${n} ended`]);

    /* ---- by time: Morning / Afternoon / Evening ---- */
    function renderByTime(list, opts, isToday) {
        const wrap = el('div', { class: 'c2-day by-time' });
        PARTS.forEach(part => {
            const inPart = list.filter(p => { const a = mins(p['Start Time']) ?? 0; return a >= part.from && a < part.to; }).sort(byStart);
            const ended = isToday ? inPart.filter(p => opts.statusFor(p).phase === 'ended') : [];
            const shown = opts.showEnded ? inPart : inPart.filter(p => !ended.includes(p));
            const now = isToday && opts.nowMinutes >= part.from && opts.nowMinutes < part.to;
            const sec = el('section', { class: 'c2-part' + (now ? ' now' : '') + (inPart.length ? '' : ' empty') });
            sec.appendChild(el('h4', { class: 'c2-part-head' }, [
                el('span', { class: 'c2-part-emoji', 'aria-hidden': 'true' }, [part.emoji]),
                `${part.label} `,
                el('span', { class: 'c2-part-n' }, [inPart.length ? `${inPart.length} session${inPart.length === 1 ? '' : 's'}` : 'nothing']),
                ...(now ? [el('span', { class: 'c2-part-now' }, ['now'])] : [])
            ]));
            if (ended.length) sec.appendChild(foldBtn(ended.length, opts.showEnded));
            shown.forEach(p => sec.appendChild(line(p, opts, true)));
            wrap.appendChild(sec);
        });
        return wrap;
    }

    /* ---- by rink: your rinks first, nearest next ---- */
    function renderByRink(list, opts, isToday) {
        const wrap = el('div', { class: 'c2-day by-rink' });
        const groups = new Map();
        list.forEach(p => {
            const key = opts.rinkKey(p);
            if (!groups.has(key)) groups.set(key, { key, name: p.LocationName || '', items: [], ...opts.rinkInfo(key, p) });
            groups.get(key).items.push(p);
        });
        const rows = [...groups.values()].sort((x, y) =>
            ((y.mine ? 1 : 0) - (x.mine ? 1 : 0)) || ((x.dist ?? 1e9) - (y.dist ?? 1e9)) || x.name.localeCompare(y.name));
        const endedAll = isToday ? list.filter(p => opts.statusFor(p).phase === 'ended').length : 0;
        if (endedAll) wrap.appendChild(foldBtn(endedAll, opts.showEnded));
        rows.forEach(g => {
            g.items.sort(byStart);
            const shown = opts.showEnded || !isToday ? g.items : g.items.filter(p => opts.statusFor(p).phase !== 'ended');
            if (!shown.length) return;   // done for today
            const sec = el('section', { class: 'c2-part c2-rink' + (g.mine ? ' mine' : '') });
            sec.appendChild(el('h4', { class: 'c2-part-head' }, [
                (g.mine ? '★ ' : '') + g.name,
                el('span', { class: 'c2-part-n' }, [g.dist != null ? opts.fmtKm(g.dist) : `${shown.length} session${shown.length === 1 ? '' : 's'}`])
            ]));
            shown.forEach(p => sec.appendChild(line(p, opts, false)));
            wrap.appendChild(sec);
        });
        return wrap;
    }

    /* ---- by distance: the nearest band first, each band in time order ---- */
    const bandLabel = (from, to) => from === 0 ? `Within ${to} km` : to === Infinity ? `Over ${from} km` : `${from} to ${to} km`;
    function renderByDistance(list, opts, isToday) {
        const wrap = el('div', { class: 'c2-day by-distance' });
        if (!opts.hasLocation) {
            // no spot to measure from yet: say so, with the two ways to set one
            wrap.classList.add('needs-spot');
            wrap.appendChild(el('div', { class: 'c2-need-spot' }, [
                el('p', {}, ['Distances need a starting point. It stays on this device.']),
                el('div', { class: 'c2-need-actions' }, [
                    el('button', { class: 'btn-primary btn-small', dataset: { cal2Locate: '1' } }, ['Use my location']),
                    el('button', { class: 'btn-secondary btn-small', dataset: { cal2Place: '1' } }, ['Type a place or postal code'])
                ])
            ]));
            return wrap;
        }
        const edges = (opts.bands && opts.bands.length ? opts.bands : [2, 5, 10, 20]).slice().sort((a, b) => a - b);
        const bands = edges.map((to, i) => ({ from: i ? edges[i - 1] : 0, to, items: [] }));
        bands.push({ from: edges[edges.length - 1], to: Infinity, items: [] });
        const unknown = { label: 'Distance unknown', items: [] };
        const km = new Map();
        list.forEach(p => {
            const d = opts.distanceFor(p);
            km.set(p, d);
            (d == null ? unknown : bands.find(b => d < b.to)).items.push(p);
        });
        const byTimeThenNear = (x, y) => ((mins(x['Start Time']) ?? 0) - (mins(y['Start Time']) ?? 0)) || ((km.get(x) ?? 1e9) - (km.get(y) ?? 1e9)) || (x.LocationName || '').localeCompare(y.LocationName || '');
        [...bands.map(b => ({ label: bandLabel(b.from, b.to), items: b.items })), unknown].forEach(g => {
            if (!g.items.length) return;
            g.items.sort(byTimeThenNear);
            const ended = isToday ? g.items.filter(p => opts.statusFor(p).phase === 'ended') : [];
            const shown = opts.showEnded ? g.items : g.items.filter(p => !ended.includes(p));
            const sec = el('section', { class: 'c2-part c2-band' });
            sec.appendChild(el('h4', { class: 'c2-part-head' }, [
                g.label + ' ',
                el('span', { class: 'c2-part-n' }, [`${g.items.length} session${g.items.length === 1 ? '' : 's'}`])
            ]));
            if (ended.length) sec.appendChild(foldBtn(ended.length, opts.showEnded));
            shown.forEach(p => sec.appendChild(line(p, opts, true)));
            wrap.appendChild(sec);
        });
        return wrap;
    }

    /** "Any distance · 2 km · 5 km …": the same Within N km filter as the pill and the Filters sheet. */
    function radiusRow(opts) {
        const row = el('div', { class: 'c2-radius', role: 'group', 'aria-label': 'How far from your spot' });
        const chip = (label, km) => el('button', {
            class: 'c2-radius-chip' + ((opts.radius || null) === km ? ' active' : ''), dataset: { cal2Radius: km == null ? '' : String(km) },
            'aria-pressed': (opts.radius || null) === km ? 'true' : 'false'
        }, [label]);
        row.appendChild(chip('Any distance', null));
        (opts.radiusOptions || []).forEach(km => row.appendChild(chip(`${km} km`, km)));
        return row;
    }

    /**
     * Render into `container`.
     * opts: { day, todayKey, nowMinutes (Toronto), by ('time' | 'rink' | 'distance'), showEnded,
     *         hasLocation, radius (km | null), radiusOptions, bands,   (by distance)
     *         fmtClock(t), fmtMins(n), fmtPrice(n), fmtKm(km), ageText(p), kindLabel(p),
     *         idFor(p), isSaved(p), alertFor(p), statusFor(p), typeFor(p),
     *         distanceFor(p), rinkKey(p), rinkInfo(key, p) → { mine, dist } }
     * Returns { label, total, types, states }.
     */
    function render(container, programs, opts) {
        const todayKey = opts.todayKey;
        const dayKey = opts.day || todayKey;
        const isToday = dayKey === todayKey;
        const weekStartKey = T.addDays(dayKey, -T.mondayIndex(dayKey));
        const weekEndKey = T.addDays(weekStartKey, 6);
        const inWeek = programs.filter(p => { const d = dateKeyOf(p); return d >= weekStartKey && d <= weekEndKey; });
        const counts = {};
        inWeek.forEach(p => { const d = dateKeyOf(p); counts[d] = (counts[d] || 0) + 1; });
        const onDay = inWeek.filter(p => dateKeyOf(p) === dayKey);
        const by = opts.by === 'rink' || opts.by === 'distance' ? opts.by : 'time';

        container.innerHTML = '';
        container.appendChild(dayStrip(weekStartKey, counts, dayKey, todayKey));
        const byBtn = (id, text) => el('button', { class: `c2-by-${id}` + (by === id ? ' active' : ''), dataset: { cal2By: id }, 'aria-pressed': by === id ? 'true' : 'false' }, [text]);
        container.appendChild(el('div', { class: 'c2-by', role: 'group', 'aria-label': 'Group sessions' }, [
            byBtn('time', 'By time of day'), byBtn('rink', 'By rink'), byBtn('distance', 'By distance')
        ]));
        if (by === 'distance' && opts.hasLocation) container.appendChild(radiusRow(opts));
        const label = longDate(dayKey);
        const { types, states } = collect(onDay, opts);
        if (by === 'distance' && !opts.hasLocation) {
            container.appendChild(renderByDistance(onDay, opts, isToday));
            return { label, total: onDay.length, types, states };
        }
        if (!onDay.length) {
            container.appendChild(el('div', { class: 'cal-empty c2-empty' }, [
                by === 'distance' && opts.radius ? `Nothing within ${opts.radius} km this day with these filters.` : 'Nothing this day with these filters.']));
            return { label, total: 0, types, states };
        }
        container.appendChild(by === 'rink' ? renderByRink(onDay, opts, isToday) : by === 'distance' ? renderByDistance(onDay, opts, isToday) : renderByTime(onDay, opts, isToday));
        return { label, total: onDay.length, types, states };
    }

    return { render };
})();

if (typeof module !== 'undefined') module.exports = window.SkateCalendar2;
