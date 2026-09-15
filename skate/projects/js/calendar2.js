/**
 * SkateCalendar2 — the experimental calendar (Settings → Display →
 * "Calendar 2.0"): a day planner anyone can read.
 *
 * Pick a day on the strip. The day is Morning / Afternoon / Evening and
 * every session is one plain line: the time first, the rink, then kind ·
 * ages · price, with a heart to save it. No bars, no grid, no cursor —
 * the way a timetable is pinned up in a community-centre lobby. "By rink"
 * groups the same lines under each rink instead (your rinks first, the
 * nearest next). On wide screens the three parts of the day sit side by
 * side. Today's ended sessions fold away behind "Show N ended" so the
 * reader lands on what is next.
 *
 * Pure renderer with the same contract as SkateCalendar. Clicks are
 * delegated in app.js: `.cal-block[data-pid]` opens the popover, and
 * `data-cal2-day`, `data-cal2-by`, `data-cal2-ended`, `data-cal2-fav`
 * carry the day strip, the By time / By rink switch, the ended fold and
 * the heart.
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
        if (a) cls += a.level === 'closed' ? ' cal-closed' : ' cal-warning';
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
            if (a) states[a.level === 'closed' ? 'closed' : 'warning'] = true;
        });
        return { types: [...types], states };
    }

    const tip = (p, opts) => {
        const a = opts.alertFor(p);
        return `${p.Activity || 'Skating'} · ${p.LocationName || ''} · ${opts.fmtClock(p['Start Time'] || '')}${p['End Time'] ? '–' + opts.fmtClock(p['End Time']) : ''}`
            + (dur(p) ? ` (${fmtDur(dur(p))})` : '') + (p.Paid ? ' · paid' : '')
            + (a ? (a.level === 'closed' ? ' · likely cancelled (rink alert)' : ' · service alert at this rink') : '')
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
            : alert ? { cls: ' warn', txt: 'Rink alert' } : null;
        const km = nameIsRink ? opts.distanceFor(p) : null;
        const meta = [
            el('span', { class: 'c2-kind ' + kindCls }, [opts.kindLabel(p)]),
            ` · ${opts.ageText(p)} · `,
            el('span', { class: p.Paid ? 'c2-paid' : 'c2-free' }, [p.Paid ? `$${opts.fmtPrice(p.Price)}` : 'Free']),
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

    /**
     * Render into `container`.
     * opts: { day, todayKey, nowMinutes (Toronto), by ('time' | 'rink'), showEnded,
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
        const by = opts.by === 'rink' ? 'rink' : 'time';

        container.innerHTML = '';
        container.appendChild(dayStrip(weekStartKey, counts, dayKey, todayKey));
        container.appendChild(el('div', { class: 'c2-by', role: 'group', 'aria-label': 'Group sessions' }, [
            el('button', { class: by === 'time' ? 'active' : '', dataset: { cal2By: 'time' }, 'aria-pressed': by === 'time' ? 'true' : 'false' }, ['By time of day']),
            el('button', { class: by === 'rink' ? 'active' : '', dataset: { cal2By: 'rink' }, 'aria-pressed': by === 'rink' ? 'true' : 'false' }, ['By rink'])
        ]));
        const label = longDate(dayKey);
        const { types, states } = collect(onDay, opts);
        if (!onDay.length) {
            container.appendChild(el('div', { class: 'cal-empty c2-empty' }, ['Nothing this day with these filters.']));
            return { label, total: 0, types, states };
        }
        container.appendChild(by === 'rink' ? renderByRink(onDay, opts, isToday) : renderByTime(onDay, opts, isToday));
        return { label, total: onDay.length, types, states };
    }

    return { render };
})();

if (typeof module !== 'undefined') module.exports = window.SkateCalendar2;
