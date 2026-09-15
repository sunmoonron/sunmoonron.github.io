/**
 * SkateCalendar2 — the experimental calendar (Settings → Display →
 * "Calendar 2.0"). One board instead of a week grid:
 *
 *   rows   = rinks with ice that day: your starred rinks first, then the
 *            nearest, then A–Z. Tap a rink name to unfold its sessions as
 *            chips (times, kind, length, price).
 *   x-axis = the day's active hours fitted to the screen, no sideways
 *            scrolling. A bar sits where the session is and is as wide as
 *            it is long, so "how long" is read at a glance, never as text.
 *   handle = a cursor on the time axis ("open at"). Rinks with ice at that
 *            moment float to the top, the rest dim. Today it starts at now;
 *            a now-line and past shading make the day feel live.
 *
 * Sessions overlap in time but never at one rink, so a row is at most a
 * pad or two deep and the board stays a list, which is what phones want.
 * On wide screens the same board simply gets more pixels per hour and
 * start times inside the bars that can hold them.
 *
 * Pure renderer with the same contract as SkateCalendar. Clicks are
 * delegated in app.js: bars and chips are `.cal-block[data-pid]` (the
 * popover), day chips carry `data-cal2-day`, rink names `data-cal2-rink`.
 * The cursor is a range input owned here: it repaints live while dragging
 * and hands `onScrub(minutes | null)` to app.js on release (null = follow
 * now again), which re-sorts the rows.
 */
window.SkateCalendar2 = (() => {
    'use strict';

    const { el } = window.SkateUI;
    const T = window.SkateTime;

    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const STEP = 15;                 // cursor snaps to the quarter hour
    const BAR_H = 22, BAR_GAP = 3;   // lane geometry (px)

    /* ---- small helpers ---- */
    const mins = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
    const dur = (p) => { const a = mins(p['Start Time']), b = mins(p['End Time']); return a == null || b == null ? 0 : ((b - a) + 1440) % 1440; };
    const fmtDur = (d) => !d ? '' : d % 60 === 0 ? `${d / 60} h` : d > 60 ? `${(d / 60).toFixed(1).replace(/\.0$/, '')} h` : `${d} min`;
    const short = (n) => (n || '')
        .replace(/\b(Community Recreation Centre|Community Centre|Recreation Centre|Community Arena|Arena|Complex|Centre)\b/g, '')
        .replace(/\s*[-–]\s*$/, '').replace(/\s+/g, ' ').trim() || n || '';
    const dateKeyOf = (p) => String(p['Start Date Time'] || p['Start Date'] || '').slice(0, 10);
    const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const noMeridiem = (s) => s.replace(/\s?[AP]\.?M\.?$/i, '');
    const hourLabel = (fmtClock, h) => fmtClock(hhmm(h * 60)).replace(':00', '');
    const snap = (m) => Math.round(m / STEP) * STEP;
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

    /** A session as a chip (inside an unfolded rink row). */
    function chip(x, opts) {
        const p = x.p;
        return el('button', { class: 'cal-block c2-chip' + stateCls(p, opts), dataset: { pid: opts.idFor(p) }, title: tip(p, opts) }, [
            el('b', {}, [`${opts.fmtClock(p['Start Time'] || '')}${p['End Time'] ? '–' + opts.fmtClock(p['End Time']) : ''}`]),
            el('span', { class: 'c2-chip-kind' }, [p.Activity || 'Skating']),
            el('i', {}, [fmtDur(dur(p))]),
            ...(p.Paid ? [el('span', { class: 'cal-price' }, ['$'])] : []),
            ...(opts.isSaved(p) ? [el('span', { class: 'cal-heart', 'aria-label': 'saved' }, ['♥'])] : [])
        ]);
    }

    /**
     * Render into `container`.
     * opts: { day, todayKey, nowMinutes (Toronto), at (minutes | null),
     *         isOpen(rinkKey), onScrub(minutes | null),
     *         fmtClock(t), fmtKm(km), idFor(p), isSaved(p), alertFor(p),
     *         statusFor(p), typeFor(p), rinkKey(p), rinkInfo(key, p) → { mine, dist } }
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

        container.innerHTML = '';
        container.appendChild(dayStrip(weekStartKey, counts, dayKey, todayKey));
        const label = longDate(dayKey);
        const { types, states } = collect(onDay, opts);
        if (!onDay.length) {
            container.appendChild(el('div', { class: 'cal-empty c2-empty' }, ['Nothing this day with these filters.']));
            return { label, total: 0, types, states };
        }

        // ---- the axis: the day's active hours, fitted to the width ----
        const items = onDay.map(p => { const a = mins(p['Start Time']) ?? 0; return { p, a, b: a + (dur(p) || 60) }; });
        let lo = Math.min(...items.map(x => Math.floor(x.a / 60))) * 60;
        let hi = Math.min(1440, Math.max(...items.map(x => Math.ceil(x.b / 60))) * 60);
        if (hi - lo < 8 * 60) { lo = Math.max(0, hi - 8 * 60); if (hi - lo < 8 * 60) hi = Math.min(1440, lo + 8 * 60); }
        const span = hi - lo;
        const pct = (m) => Math.min(100, Math.max(0, (m - lo) / span * 100));
        const nowSnap = snap(opts.nowMinutes);
        let t = opts.at != null ? opts.at : (isToday ? nowSnap : 18 * 60);
        t = Math.min(hi, Math.max(lo, snap(t)));
        const clock = (m) => opts.fmtClock(hhmm(m));

        // ---- rinks: one row each, open-at-cursor rows first ----
        const groups = new Map();
        items.forEach(x => {
            const key = opts.rinkKey(x.p);
            if (!groups.has(key)) groups.set(key, { key, name: x.p.LocationName || '', items: [], ...opts.rinkInfo(key, x.p) });
            groups.get(key).items.push(x);
        });
        const rows = [...groups.values()];
        rows.forEach(g => g.items.sort((x, y) => x.a - y.a));
        const openAt = (g, tt) => g.items.some(x => x.a <= tt && x.b > tt);
        const cmp = (x, y) => ((y.mine ? 1 : 0) - (x.mine ? 1 : 0)) || ((x.dist ?? 1e9) - (y.dist ?? 1e9)) || x.name.localeCompare(y.name);
        const openRows = rows.filter(g => openAt(g, t)).sort(cmp);
        const restRows = rows.filter(g => !openAt(g, t)).sort(cmp);

        const readout = el('div', { class: 'c2-readout' });
        const board = el('div', { class: 'c2-board' });

        // header row: hour ticks + the cursor
        const axis = el('div', { class: 'c2-lane c2-axis' });
        const tickStep = (container.clientWidth < 600 || span > 14 * 60) ? 3 : 2;
        for (let h = Math.ceil(lo / 60); h * 60 <= hi; h += 1) {
            if (h % tickStep === 0 || h * 60 === lo) axis.appendChild(el('span', { class: 'c2-tick', style: `left:${pct(h * 60)}%` }, [hourLabel(opts.fmtClock, h)]));
        }
        const cursor = el('input', { type: 'range', class: 'c2-cursor', min: lo, max: hi, step: STEP, value: t, 'aria-label': 'Time of day', title: 'Drag: which rinks are open at this time' });
        axis.appendChild(cursor);
        board.appendChild(el('div', { class: 'c2-row c2-head' }, [el('div', { class: 'c2-name' }, [`${rows.length} rink${rows.length === 1 ? '' : 's'}`]), axis]));

        const decorate = (lane) => {
            for (let h = Math.ceil(lo / 60) + 1; h * 60 < hi; h++) lane.appendChild(el('span', { class: 'c2-grid', style: `left:${pct(h * 60)}%` }));
            if (isToday && opts.nowMinutes > lo) {
                lane.appendChild(el('span', { class: 'c2-past', style: `width:${pct(opts.nowMinutes)}%` }));
                if (opts.nowMinutes < hi) lane.appendChild(el('span', { class: 'c2-now', style: `left:${pct(opts.nowMinutes)}%` }));
            }
            lane.appendChild(el('span', { class: 'c2-cur', style: `left:${pct(t)}%` }));
        };

        const rowEl = (g) => {
            const unfolded = !!(opts.isOpen && opts.isOpen(g.key));
            const row = el('div', { class: 'c2-row' + (openAt(g, t) ? ' is-open' : ' is-closed') + (g.mine ? ' mine' : '') + (unfolded ? ' unfolded' : ''), dataset: { iv: g.items.map(x => `${x.a}-${x.b}`).join(',') } });
            row.appendChild(el('button', { class: 'c2-name', dataset: { cal2Rink: g.key }, 'aria-expanded': unfolded ? 'true' : 'false', title: `${g.name}. Tap for its sessions.` }, [
                el('span', { class: 'c2-name-text' }, [(g.mine ? '★ ' : '') + short(g.name)]),
                ...(g.dist != null ? [el('small', {}, [opts.fmtKm(g.dist)])] : [])
            ]));
            // two pads at once → two lanes
            const laneEnd = [];
            const placed = g.items.map(x => {
                let li = laneEnd.findIndex(end => end <= x.a);
                if (li < 0) { li = laneEnd.length; laneEnd.push(0); }
                laneEnd[li] = x.b;
                return { ...x, li };
            });
            const lane = el('div', { class: 'c2-lane', style: `height:${laneEnd.length * (BAR_H + BAR_GAP) + BAR_GAP}px` });
            decorate(lane);
            placed.forEach(({ p, a, b, li }) => {
                lane.appendChild(el('button', {
                    class: 'cal-block c2-bar' + stateCls(p, opts), dataset: { pid: opts.idFor(p), start: noMeridiem(opts.fmtClock(p['Start Time'] || '')) },
                    title: tip(p, opts), style: `left:${pct(a)}%;width:${(b - a) / span * 100}%;top:${BAR_GAP + li * (BAR_H + BAR_GAP)}px`
                }));
            });
            row.appendChild(lane);
            if (unfolded) row.appendChild(el('div', { class: 'c2-chips' }, g.items.map(x => chip(x, opts))));
            return row;
        };

        const groupHead = (txt, n, muted) => el('div', { class: 'c2-group' + (muted ? ' muted' : '') }, [txt, el('span', { class: 'c2-group-n' }, [String(n)])]);
        const atNow = isToday && t === nowSnap;
        if (openRows.length) board.appendChild(groupHead(atNow ? 'On the ice now' : `Open at ${clock(t)}`, openRows.length, false));
        openRows.forEach(g => board.appendChild(rowEl(g)));
        if (restRows.length) {
            board.appendChild(groupHead(openRows.length ? (atNow ? 'Not on the ice now' : `Not open at ${clock(t)}`) : `Nothing open at ${clock(t)} — the rest of the day`, restRows.length, true));
            restRows.forEach(g => board.appendChild(rowEl(g)));
        }
        container.append(readout, board);

        // ---- the cursor: live repaint while dragging, re-sort on release ----
        const paint = (tt) => {
            let n = 0;
            board.querySelectorAll('.c2-row[data-iv]').forEach(row => {
                const open = row.dataset.iv.split(',').some(iv => { const [a, b] = iv.split('-').map(Number); return a <= tt && b > tt; });
                row.classList.toggle('is-open', open); row.classList.toggle('is-closed', !open);
                if (open) n++;
            });
            board.querySelectorAll('.c2-cur').forEach(c => { c.style.left = `${pct(tt)}%`; });
            readout.innerHTML = '';
            readout.append(
                el('b', {}, [clock(tt)]),
                el('span', {}, [n ? `${n} rink${n === 1 ? '' : 's'} open` : 'nothing open']),
                ...(isToday && tt !== nowSnap ? [el('button', { class: 'c2-at-now', type: 'button', title: 'Back to the current time' }, ['Now'])] : [])
            );
        };
        cursor.addEventListener('input', () => paint(+cursor.value));
        cursor.addEventListener('change', () => { if (opts.onScrub) opts.onScrub(+cursor.value === nowSnap && isToday ? null : +cursor.value); });
        readout.addEventListener('click', (e) => {
            if (!e.target.closest('.c2-at-now')) return;
            e.stopPropagation();
            cursor.value = nowSnap; paint(nowSnap);
            if (opts.onScrub) opts.onScrub(null);
        });
        paint(t);

        // wide screens: start times inside the bars that can hold them
        const pxPerHour = axis.clientWidth / (span / 60);
        if (pxPerHour >= 40) board.querySelectorAll('.c2-bar').forEach(b => { if (b.offsetWidth >= 46) b.textContent = b.dataset.start; });

        return { label, total: onDay.length, types, states };
    }

    return { render };
})();

if (typeof module !== 'undefined') module.exports = window.SkateCalendar2;
