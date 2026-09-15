/**
 * SkateCalendar2 — the experimental calendar (Settings → Display →
 * "Calendar 2.0"). The research behind it is in docs/calendar-2.md.
 *
 * The classic week grid puts text in every block, which is fine on a wide
 * screen and unreadable in a 130 px phone column. These layouts each
 * answer one question with as little text as possible:
 *
 *   at    — "Open at": one time-of-day slider over a density strip (how
 *           many rinks are open per quarter hour). The list under it is
 *           the slice at that moment: every rink open then, yours first
 *           and nearest next, each with how long it still runs, plus what
 *           starts within the hour. Sessions overlap in time but never at
 *           one rink, so a slice is always a short list of unique rinks —
 *           the 2-D calendar collapses into one slider and one list.
 *   hours — one day as hour rows. Every session is a small chip
 *           "6:15 Centennial · 1 h" (start, rink, length). The agenda-by-
 *           hour hybrid: scannable on a phone, honest about how long a
 *           session runs, nothing to expand.
 *   rinks — one day as a timetable (the TV-guide layout): rows are rinks,
 *           the x-axis is the time of day, a bar runs exactly as long as
 *           the session. Compare rinks at 6 PM at a glance.
 *   week  — the whole week as a heatmap: 7 columns × hour rows, darker =
 *           more sessions running that hour. Zero text, fits any width;
 *           tapping an hour opens it in `hours`.
 *
 * Pure renderer with the same contract as SkateCalendar: app.js hands it
 * the filtered programs plus callbacks and reads back { label, total,
 * types, states } for the header and legend. Clicks are delegated in
 * app.js: chips and bars are `.cal-block[data-pid]` like the classic grid
 * (same popover), day chips carry `data-cal2-day`, heat cells
 * `data-cal2-cell` ("date|hour"), the layout bar `data-cal2-mode`.
 */
window.SkateCalendar2 = (() => {
    'use strict';

    const { el } = window.SkateUI;
    const T = window.SkateTime;

    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const MODES = [['at', 'Open at'], ['rinks', 'Rinks'], ['hours', 'Hours'], ['week', 'Week']];
    const PX_PER_HOUR = 64, LANE_H = 24, LANE_GAP = 3;   // timetable geometry

    /* ---- small helpers ---- */
    const mins = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
    const dur = (p) => { const a = mins(p['Start Time']), b = mins(p['End Time']); return a == null || b == null ? 0 : ((b - a) + 1440) % 1440; };
    const fmtDur = (d) => !d ? '' : d % 60 === 0 ? `${d / 60} h` : d > 60 ? `${(d / 60).toFixed(1).replace(/\.0$/, '')} h` : `${d} min`;
    const short = (n) => (n || '')
        .replace(/\b(Community Recreation Centre|Community Centre|Recreation Centre|Community Arena|Arena|Complex|Centre)\b/g, '')
        .replace(/\s*[-–]\s*$/, '').replace(/\s+/g, ' ').trim() || n || '';
    const dateKeyOf = (p) => String(p['Start Date Time'] || p['Start Date'] || '').slice(0, 10);
    const clockNoMeridiem = (fmtClock, t) => fmtClock(t || '').replace(/\s?[AP]\.?M\.?$/i, '');
    const hourLabel = (fmtClock, h) => fmtClock(`${String(h % 24).padStart(2, '0')}:00`).replace(':00', '');
    function longDate(key) {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
    function weekLabel(startKey) {
        const fmt = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
        return `${fmt(startKey)} – ${fmt(T.addDays(startKey, 6))}`;
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
            + (p.Paid ? ' · paid' : '') + (a ? (a.level === 'closed' ? ' · likely cancelled (rink alert)' : ' · service alert at this rink') : '')
            + (p.Unverified ? ' · unverified schedule' : '');
    };

    /* ---- shared chrome ---- */
    function modeBar(mode) {
        return el('div', { class: 'c2-modes', role: 'group', 'aria-label': 'Calendar layout' }, MODES.map(([id, label]) =>
            el('button', { class: id === mode ? 'active' : '', dataset: { cal2Mode: id }, 'aria-pressed': id === mode ? 'true' : 'false' }, [label])));
    }

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

    const empty = (txt) => el('div', { class: 'cal-empty c2-empty' }, [txt]);

    /* ---- hours: one row per hour, chips inside ---- */
    function renderHours(list, opts, dayKey) {
        const wrap = el('div', { class: 'c2-hours' });
        if (!list.length) { wrap.appendChild(empty('Nothing this day with these filters.')); return wrap; }
        const byHour = new Map();
        list.forEach(p => {
            const h = Math.floor((mins(p['Start Time']) ?? 0) / 60);
            if (!byHour.has(h)) byHour.set(h, []);
            byHour.get(h).push(p);
        });
        const hours = [...byHour.keys()];
        const first = Math.min(6, ...hours), last = Math.max(22, ...hours);
        const nowH = dayKey === opts.todayKey ? Math.floor(opts.nowMinutes / 60) : -1;
        for (let h = first; h <= last; h++) {
            const group = (byHour.get(h) || []).sort((a, b) =>
                ((mins(a['Start Time']) ?? 0) - (mins(b['Start Time']) ?? 0)) || (a.LocationName || '').localeCompare(b.LocationName || ''));
            const row = el('div', {
                class: 'c2-hour' + (group.length ? '' : ' empty') + (h === nowH ? ' now' : '') + (nowH >= 0 && h < nowH ? ' past' : ''),
                dataset: { hour: h }
            });
            row.appendChild(el('span', { class: 'c2-hour-label' }, [hourLabel(opts.fmtClock, h)]));
            const chips = el('div', { class: 'c2-chips' });
            group.forEach(p => {
                chips.appendChild(el('button', { class: 'cal-block c2-chip' + stateCls(p, opts), dataset: { pid: opts.idFor(p) }, title: tip(p, opts) }, [
                    el('b', {}, [clockNoMeridiem(opts.fmtClock, p['Start Time'])]),   // the row label carries AM/PM
                    el('span', { class: 'c2-chip-rink' }, [short(p.LocationName)]),
                    el('i', {}, [fmtDur(dur(p))]),
                    ...(p.Paid ? [el('span', { class: 'cal-price' }, ['$'])] : []),
                    ...(opts.isSaved(p) ? [el('span', { class: 'cal-heart', 'aria-label': 'saved' }, ['♥'])] : [])
                ]));
            });
            row.appendChild(chips);
            wrap.appendChild(row);
        }
        return wrap;
    }

    /* ---- rinks: timetable, rows = rinks, x = time of day ---- */
    function renderRinks(list, opts, dayKey) {
        const wrap = el('div', { class: 'c2-tt' });
        if (!list.length) { wrap.appendChild(empty('Nothing this day with these filters.')); return wrap; }

        // axis: 6 AM → 11 PM, stretched when a session falls outside
        let lo = 6, hi = 23;
        list.forEach(p => {
            const a = mins(p['Start Time']);
            if (a == null) return;
            lo = Math.min(lo, Math.floor(a / 60));
            hi = Math.max(hi, Math.min(24, Math.ceil((a + (dur(p) || 60)) / 60)));
        });
        const width = (hi - lo) * PX_PER_HOUR;

        const groups = new Map();
        list.forEach(p => {
            const key = opts.rinkKey(p);
            if (!groups.has(key)) groups.set(key, { key, name: p.LocationName || '', items: [], ...opts.rinkInfo(key, p) });
            groups.get(key).items.push(p);
        });
        const rows = [...groups.values()].sort((a, b) =>
            ((b.mine ? 1 : 0) - (a.mine ? 1 : 0)) || ((a.dist ?? 1e9) - (b.dist ?? 1e9)) || a.name.localeCompare(b.name));

        const headLane = el('div', { class: 'c2-tt-lane', style: `width:${width}px` });
        for (let h = lo; h < hi; h++) headLane.appendChild(el('span', { class: 'c2-tt-hour', style: `left:${(h - lo) * PX_PER_HOUR}px` }, [hourLabel(opts.fmtClock, h)]));
        wrap.appendChild(el('div', { class: 'c2-tt-row c2-tt-head' }, [
            el('div', { class: 'c2-tt-rink' }, [`${rows.length} rink${rows.length === 1 ? '' : 's'}`]), headLane
        ]));

        const isToday = dayKey === opts.todayKey;
        rows.forEach(r => {
            r.items.sort((a, b) => (mins(a['Start Time']) ?? 0) - (mins(b['Start Time']) ?? 0));
            // overlapping sessions at one rink (two pads) stack into lanes
            const laneEnd = [];
            const placed = r.items.map(p => {
                const a = mins(p['Start Time']) ?? 0, b = a + (dur(p) || 60);
                let li = laneEnd.findIndex(end => end <= a);
                if (li < 0) { li = laneEnd.length; laneEnd.push(0); }
                laneEnd[li] = b;
                return { p, a, b, li };
            });
            const lane = el('div', { class: 'c2-tt-lane', style: `width:${width}px;height:${laneEnd.length * (LANE_H + LANE_GAP) + LANE_GAP}px` });
            for (let h = lo; h < hi; h++) lane.appendChild(el('span', { class: 'c2-tt-grid', style: `left:${(h - lo) * PX_PER_HOUR}px` }));
            placed.forEach(({ p, a, b, li }) => {
                const left = (a / 60 - lo) * PX_PER_HOUR, w = Math.max(10, (b - a) / 60 * PX_PER_HOUR - 2);
                const bar = el('button', {
                    class: 'cal-block c2-bar' + stateCls(p, opts), dataset: { pid: opts.idFor(p) }, title: tip(p, opts),
                    style: `left:${left}px;width:${w}px;top:${LANE_GAP + li * (LANE_H + LANE_GAP)}px`
                });
                if (w >= 46) bar.appendChild(el('span', {}, [clockNoMeridiem(opts.fmtClock, p['Start Time']) + (p.Paid ? ' $' : '') + (opts.isSaved(p) ? ' ♥' : '')]));
                lane.appendChild(bar);
            });
            if (isToday) {
                const x = (opts.nowMinutes / 60 - lo) * PX_PER_HOUR;
                if (x >= 0 && x <= width) lane.appendChild(el('span', { class: 'c2-now', style: `left:${x}px` }));
            }
            wrap.appendChild(el('div', { class: 'c2-tt-row' }, [
                el('div', { class: 'c2-tt-rink' + (r.mine ? ' mine' : ''), title: r.name }, [
                    el('span', { class: 'c2-tt-name' }, [(r.mine ? '★ ' : '') + short(r.name)]),
                    ...(r.dist != null ? [el('small', {}, [opts.fmtKm(r.dist)])] : [])
                ]),
                lane
            ]));
        });
        wrap.dataset.scrollTo = isToday ? String(Math.max(0, (opts.nowMinutes / 60 - lo - 0.5) * PX_PER_HOUR)) : '0';
        return wrap;
    }

    /* ---- week: heatmap, 7 columns × hour rows ---- */
    function renderWeek(inWeek, opts, weekStartKey) {
        const days = Array.from({ length: 7 }, (_, i) => T.addDays(weekStartKey, i));
        const running = {}, starts = {};
        let max = 0, first = 6;
        inWeek.forEach(p => {
            const d = dateKeyOf(p), a = mins(p['Start Time']);
            if (a == null) return;
            const b = a + (dur(p) || 60);
            first = Math.min(first, Math.floor(a / 60));
            for (let h = Math.floor(a / 60); h < Math.ceil(b / 60) && h < 24; h++) {
                const k = `${d}|${h}`;
                running[k] = (running[k] || 0) + 1;
                max = Math.max(max, running[k]);
            }
            const k0 = `${d}|${Math.floor(a / 60)}`;
            starts[k0] = (starts[k0] || 0) + 1;
        });
        const table = el('div', { class: 'c2-heat', role: 'grid' });
        if (!inWeek.length) { table.appendChild(empty('Nothing this week with these filters.')); return table; }
        table.appendChild(el('span', { class: 'c2-heat-corner' }));
        days.forEach((d, i) => table.appendChild(el('button', {
            class: 'c2-heat-day' + (d === opts.todayKey ? ' today' : ''), dataset: { cal2Day: d }, title: `Open ${longDate(d)}`
        }, [el('b', {}, [DAY_LABELS[i]]), d.slice(8).replace(/^0/, '')])));
        const nowH = Math.floor(opts.nowMinutes / 60);
        for (let h = first; h < 24; h++) {
            table.appendChild(el('span', { class: 'c2-heat-hour' }, [hourLabel(opts.fmtClock, h)]));
            days.forEach(d => {
                const n = running[`${d}|${h}`] || 0, s = starts[`${d}|${h}`] || 0;
                const past = d < opts.todayKey || (d === opts.todayKey && h < nowH);
                const pct = n ? Math.round(16 + 64 * n / max) : 0;
                table.appendChild(el('button', {
                    class: 'c2-cell' + (n ? '' : ' empty') + (past ? ' past' : '') + (d === opts.todayKey && h === nowH ? ' now' : ''),
                    dataset: { cal2Cell: `${d}|${h}` },
                    style: n ? `--p:${pct}%` : null,
                    disabled: n ? null : 'disabled',
                    title: n ? `${n} session${n === 1 ? '' : 's'} on the ice at ${hourLabel(opts.fmtClock, h)}, ${longDate(d)}${s ? ` (${s} start${s === 1 ? 's' : ''} this hour)` : ''}. Tap to open the hour.` : 'Nothing on the ice'
                }, [n ? String(n) : '']));
            });
        }
        return table;
    }


    /* ---- open at: one time scrubber; the slice at t is a short, sorted list ---- */
    const STEP = 15;   // minutes; Toronto sessions start on the quarter hour
    function renderAt(list, opts, dayKey) {
        const wrap = el('div', { class: 'c2-at' });
        if (!list.length) { wrap.appendChild(empty('Nothing this day with these filters.')); return wrap; }
        const isToday = dayKey === opts.todayKey;
        const items = list.map(p => { const a = mins(p['Start Time']); return a == null ? null : { p, a, b: a + (dur(p) || 60) }; }).filter(Boolean);
        // axis: 6 AM → 11 PM, stretched to the day's sessions
        let lo = 6 * 60, hi = 23 * 60;
        items.forEach(({ a, b }) => { lo = Math.min(lo, Math.floor(a / 60) * 60); hi = Math.max(hi, Math.min(1440, Math.ceil(b / 60) * 60)); });
        // t: the reader's last scrub, else now (today) or 6 PM
        let t = opts.at != null ? opts.at : isToday ? opts.nowMinutes : 18 * 60;
        t = Math.min(hi, Math.max(lo, Math.round(t / STEP) * STEP));

        // the overview: how many rinks are open, per quarter hour
        const bins = [];
        for (let m = lo; m < hi; m += STEP) bins.push(items.filter(x => x.a <= m && x.b > m).length);
        const max = Math.max(1, ...bins);
        const strip = el('div', { class: 'c2-strip', 'aria-hidden': 'true' }, bins.map((n, i) => el('i', {
            class: isToday && lo + (i + 1) * STEP <= opts.nowMinutes ? 'past' : '',
            style: `height:${n ? Math.max(12, Math.round(100 * n / max)) : 4}%`
        })));
        const range = el('input', { type: 'range', class: 'c2-range', min: lo, max: hi, step: STEP, value: t, 'aria-label': 'Time of day' });
        const scrub = el('div', { class: 'c2-scrub' }, [strip, range]);
        if (isToday && opts.nowMinutes >= lo && opts.nowMinutes <= hi) {
            scrub.appendChild(el('span', { class: 'c2-now c2-now-strip', style: `left:${(opts.nowMinutes - lo) / (hi - lo) * 100}%` }));
        }
        const ticks = el('div', { class: 'c2-ticks' });
        for (let h = Math.ceil(lo / 60); h * 60 <= hi; h += 3) ticks.appendChild(el('span', { style: `left:${(h * 60 - lo) / (hi - lo) * 100}%` }, [hourLabel(opts.fmtClock, h)]));
        const readout = el('div', { class: 'c2-at-readout' });
        const slice = el('div', { class: 'c2-slice' });
        wrap.append(readout, scrub, ticks, slice);

        const clock = (m) => opts.fmtClock(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
        const chip = (p) => el('button', { class: 'cal-block c2-chip' + stateCls(p, opts), dataset: { pid: opts.idFor(p) }, title: tip(p, opts) }, [
            el('b', {}, [clockNoMeridiem(opts.fmtClock, p['Start Time'])]),
            el('span', { class: 'c2-chip-rink' }, [short(p.LocationName)]),
            el('i', {}, [fmtDur(dur(p))]),
            ...(p.Paid ? [el('span', { class: 'cal-price' }, ['$'])] : [])
        ]);

        /** Repaint the slice for time tt: who is open (mine, then nearest), then what starts next. */
        const paint = (tt) => {
            const open = items.filter(x => x.a <= tt && x.b > tt)
                .map(x => ({ ...x, ...opts.rinkInfo(opts.rinkKey(x.p), x.p) }))
                .sort((x, y) => ((y.mine ? 1 : 0) - (x.mine ? 1 : 0)) || ((x.dist ?? 1e9) - (y.dist ?? 1e9)) || (y.b - x.b));
            const next = items.filter(x => x.a > tt).sort((x, y) => x.a - y.a);
            const soon = open.length ? next.filter(x => x.a <= tt + 60).slice(0, 6) : next.slice(0, 5);
            readout.innerHTML = '';
            readout.append(
                el('b', {}, [clock(tt)]),
                el('span', {}, [open.length ? `${open.length} rink${open.length === 1 ? '' : 's'} open` : 'nothing open']),
                ...(isToday ? [el('button', { class: 'c2-at-now', type: 'button', title: 'Back to the current time' }, ['Now'])] : [])
            );
            slice.innerHTML = '';
            open.forEach(({ p, a, b, mine, dist }) => {
                const pct = Math.round((tt - a) / (b - a) * 100);
                slice.appendChild(el('button', { class: 'cal-block c2-card' + stateCls(p, opts), dataset: { pid: opts.idFor(p) }, title: tip(p, opts) }, [
                    el('span', { class: 'c2-card-top' }, [
                        el('b', {}, [(mine ? '★ ' : '') + short(p.LocationName)]),
                        ...(dist != null ? [el('small', {}, [opts.fmtKm(dist)])] : []),
                        el('span', { class: 'c2-card-kind' }, [p.Activity || '']),
                        ...(p.Paid ? [el('span', { class: 'cal-price' }, ['$'])] : []),
                        ...(opts.isSaved(p) ? [el('span', { class: 'cal-heart', 'aria-label': 'saved' }, ['♥'])] : [])
                    ]),
                    el('span', { class: 'c2-card-time' }, [
                        `${opts.fmtClock(p['Start Time'] || '')}${p['End Time'] ? '–' + opts.fmtClock(p['End Time']) : ''} · ${tt === a ? 'starts then' : `${fmtDur(b - tt)} left`}`
                    ]),
                    el('span', { class: 'c2-card-bar' }, [el('i', { style: `width:${pct}%` })])
                ]));
            });
            if (soon.length) {
                slice.appendChild(el('div', { class: 'c2-soon-label' }, [open.length ? 'Starting within the hour' : 'Next starts']));
                slice.appendChild(el('div', { class: 'c2-chips' }, soon.map(({ p }) => chip(p))));
            }
        };
        const goTo = (m) => { t = Math.min(hi, Math.max(lo, Math.round(m / STEP) * STEP)); range.value = t; paint(t); if (opts.onScrub) opts.onScrub(t); };
        range.addEventListener('input', () => goTo(+range.value));
        readout.addEventListener('click', (e) => { if (e.target.closest('.c2-at-now')) { e.stopPropagation(); goTo(opts.nowMinutes); } });
        paint(t);
        return wrap;
    }

    /**
     * Render into `container`.
     * opts: { mode, day, todayKey, nowMinutes (Toronto), scrollHour, at, onScrub(t),
     *         fmtClock(t), fmtKm(km), idFor(p), isSaved(p), alertFor(p),
     *         statusFor(p), typeFor(p), rinkKey(p), rinkInfo(key, p) → { mine, dist } }
     * Returns { label, total, types, states, mode, day, weekStart }.
     */
    function render(container, programs, opts) {
        const mode = MODES.some(m => m[0] === opts.mode) ? opts.mode : 'at';
        const dayKey = opts.day || opts.todayKey;
        const weekStartKey = T.addDays(dayKey, -T.mondayIndex(dayKey));
        const weekEndKey = T.addDays(weekStartKey, 6);
        const inWeek = programs.filter(p => { const d = dateKeyOf(p); return d >= weekStartKey && d <= weekEndKey; });
        const counts = {};
        inWeek.forEach(p => { const d = dateKeyOf(p); counts[d] = (counts[d] || 0) + 1; });
        const onDay = inWeek.filter(p => dateKeyOf(p) === dayKey);

        container.innerHTML = '';
        container.appendChild(modeBar(mode));
        let body, label, scope;
        if (mode === 'week') {
            body = renderWeek(inWeek, opts, weekStartKey);
            label = weekLabel(weekStartKey);
            scope = inWeek;
        } else {
            container.appendChild(dayStrip(weekStartKey, counts, dayKey, opts.todayKey));
            body = mode === 'rinks' ? renderRinks(onDay, opts, dayKey) : mode === 'at' ? renderAt(onDay, opts, dayKey) : renderHours(onDay, opts, dayKey);
            label = longDate(dayKey);
            scope = onDay;
        }
        container.appendChild(body);

        // land on the current hour (today) or the hour a heat cell asked for
        if (mode === 'rinks' && body.dataset.scrollTo) body.scrollLeft = +body.dataset.scrollTo;
        if (mode === 'hours' && opts.scrollHour != null) {
            const row = body.querySelector(`.c2-hour[data-hour="${opts.scrollHour}"]`);
            if (row) row.scrollIntoView({ block: 'start', behavior: 'auto' });
        }

        const { types, states } = collect(scope, opts);
        return { label, total: scope.length, types, states, mode, day: dayKey, weekStart: weekStartKey };
    }

    return { render, MODES };
})();

if (typeof module !== 'undefined') module.exports = window.SkateCalendar2;
