/**
 * SkateCalendar — the week view for planning.
 *
 * A pure renderer: app.js hands it the CURRENT FILTERED programs plus a
 * few callbacks (saved?, alert?, status?, id, type) and a week offset; it
 * draws a day strip (Mon 14 … Sun 20, tap to jump) over a Monday→Sunday
 * grid where every session is a small block. Saved programs glow, paid
 * ones are gold, alert-flagged ones are struck, live ones pulse.
 *
 * Crowded days (v3.5): once a day holds more than `maxBlocks` sessions,
 * sessions that start in the same hour fold into one "time block" —
 * "10:00 AM–12:00 PM · 5 sessions · Malvern, Agincourt +3" — so a column
 * never grows past ~16 blocks and text never shrinks. Tapping a time
 * block expands it IN PLACE (app.js keeps the open set and re-renders;
 * `opts.isOpen(date, hour)` says which are open): its sessions appear as
 * ordinary blocks under it, tap again to fold. Nothing leaves the grid.
 * Clicking is handled by app.js via delegation (data-pid / data-cluster),
 * same pattern as the program list.
 *
 * Layout: 7 columns that horizontally scroll on small screens; the day
 * strip doubles as the scroll affordance and lights the day in view (today,
 * on wide screens where nothing scrolls). Tapping a chip flashes its column.
 */
window.SkateCalendar = (() => {
    'use strict';

    const { el, escapeHtml } = window.SkateUI;
    const T = window.SkateTime;

    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    /** Monday of (this Toronto week + offset weeks) as 'YYYY-MM-DD'. */
    function weekStart(weekOffset = 0) {
        const today = T.todayKey();
        return T.addDays(today, -T.mondayIndex(today) + weekOffset * 7);
    }

    /** 'Jul 14 – Jul 20' for the header. */
    function weekLabel(startKey) {
        const fmt = (key) => {
            const [y, m, d] = key.split('-').map(Number);
            return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
        };
        return `${fmt(startKey)} – ${fmt(T.addDays(startKey, 6))}`;
    }

    const scrolls = (grid) => grid.scrollWidth > grid.clientWidth + 4;

    /** How many px of `col` sit inside the grid's viewport right now. */
    function visiblePx(grid, col) {
        const left = grid.scrollLeft, right = left + grid.clientWidth;
        return Math.max(0, Math.min(col.offsetLeft + col.offsetWidth, right) - Math.max(col.offsetLeft, left));
    }

    /**
     * Jump to `dateKey`'s column: scroll it in when the grid scrolls (phones),
     * and flash it everywhere so the tap visibly lands — on wide screens all
     * seven columns are already there and the flash is the whole answer.
     */
    function scrollToDate(container, dateKey) {
        const grid = container.querySelector('.cal-grid');
        const col = grid && grid.querySelector(`.cal-day[data-date="${dateKey}"]`);
        if (!grid || !col) return;
        if (scrolls(grid)) {
            // instant on purpose: smooth scrolling silently no-ops in some mobile viewports
            grid.scrollLeft = Math.max(0, col.offsetLeft - 12);
            markInView(container, dateKey);
        }
        col.classList.remove('pinged');
        void col.offsetWidth;   // restart the animation on a second tap
        col.classList.add('pinged');
    }

    function markInView(container, dateKey) {
        container.querySelectorAll('.cal-daychip').forEach(c => c.classList.toggle('in-view', c.dataset.scrollDate === dateKey));
    }

    /**
     * Which chip is lit. When the grid scrolls (phones) the lit chip is the
     * column the reader is looking at: it stays lit while its column is still
     * mostly on screen, otherwise the most visible column takes over (so
     * "Sun", which can never be the leftmost column, stays lit after a tap).
     * When every column fits (wide screens) no column is "in view" in
     * particular, so today is lit — never Monday by accident.
     */
    function syncDayStrip(container) {
        const grid = container.querySelector('.cal-grid');
        if (!grid) return;
        const cols = [...grid.querySelectorAll('.cal-day')];
        if (!cols.length) return;
        if (!scrolls(grid)) {
            const today = cols.find(c => c.classList.contains('today'));
            markInView(container, today ? today.dataset.date : null);
            return;
        }
        const lit = container.querySelector('.cal-daychip.in-view');
        const litCol = lit && cols.find(c => c.dataset.date === lit.dataset.scrollDate);
        if (litCol && visiblePx(grid, litCol) >= Math.min(litCol.offsetWidth, grid.clientWidth) * 0.6) return;
        let best = cols[0], bestPx = -1;
        cols.forEach(c => {   // ties (two full columns on screen) go to today, else the left one
            const px = visiblePx(grid, c);
            if (px > bestPx || (px === bestPx && c.classList.contains('today'))) { best = c; bestPx = px; }
        });
        markInView(container, best.dataset.date);
    }

    /** One tappable session block. */
    function sessionBlock(p, opts) {
        const saved = opts.isSaved(p);
        const alert = opts.alertFor(p);
        const st = opts.statusFor(p);
        let cls = 'cal-block';
        const type = opts.typeFor && opts.typeFor(p);
        if (type) cls += ` cal-type-${type}`;   // same palette as the list badges
        if (p.Paid) cls += ' cal-paid';
        if (saved) cls += ' cal-saved';
        if (alert) cls += alert.level === 'closed' ? ' cal-closed' : ' cal-warning';
        if (st.phase === 'live') cls += ' cal-live';
        else if (st.phase === 'soon') cls += ' cal-soon';
        else if (st.phase === 'ended') cls += ' cal-ended';
        if (p.Unverified) cls += ' cal-unverified';

        const hoverBits = [
            p.Activity || '', 'at', p.LocationName || '',
            alert ? (alert.level === 'closed' ? '(likely cancelled, rink alert)' : '(service alert at this rink)') : '',
            p.Unverified ? '(unverified schedule)' : ''
        ].filter(Boolean).join(' ');
        const block = el('button', { class: cls, dataset: { pid: opts.idFor(p) }, title: hoverBits });
        const timeTxt = opts.fmtClock(p['Start Time'] || '') + (p['End Time'] ? '–' + opts.fmtClock(p['End Time']) : '');
        block.appendChild(el('span', { class: 'cal-block-time' }, [
            timeTxt,
            ...(p.Paid ? [el('span', { class: 'cal-price' }, [` $${p.Price == null ? '' : Number(p.Price).toFixed(2).replace(/\.00$/, '')}`])] : []),
            ...(saved ? [el('span', { class: 'cal-heart', 'aria-label': 'saved' }, [' ♥'])] : [])
        ]));
        block.appendChild(el('span', { class: 'cal-block-title' }, [p.Activity || 'Skating']));
        if (alert && alert.level === 'closed') block.appendChild(el('span', { class: 'cal-tag' }, ['likely cancelled']));
        block.appendChild(el('span', { class: 'cal-block-loc' }, [p.LocationName || '']));
        return block;
    }

    const mins = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
    const fmtDur = (d) => d % 60 === 0 ? `${d / 60} h` : d > 60 ? `${(d / 60).toFixed(1).replace(/\.0$/, '')} h` : `${d} min`;
    /** "1 h", "1–3 h", "45 min–1.5 h" for a set of session lengths in minutes. */
    function durRange(ds) {
        if (!ds.length) return '';
        const lo = Math.min(...ds), hi = Math.max(...ds);
        if (lo === hi) return fmtDur(lo);
        return (lo % 60 === 0 && hi % 60 === 0) ? `${lo / 60}–${hi / 60} h` : `${fmtDur(lo)}–${fmtDur(hi)}`;
    }

    /**
     * Several sessions starting in the same hour → one time block (open =
     * its sessions follow). Labelled by START times and lengths ("Starts
     * 6:00–6:30 PM · 5 sessions · 1–3 h"), never first-start-to-last-end:
     * a block reading 6–9 PM scared off anyone who only wanted an hour.
     */
    function clusterBlock(dateKey, hour, list, opts, open) {
        const starts = list.map(p => p['Start Time'] || '').filter(Boolean).sort();
        const first = starts[0] || '', last = starts[starts.length - 1] || '';
        const timeTxt = !first ? '' : 'Starts ' + (first === last ? opts.fmtClock(first) : `${opts.fmtClock(first)}–${opts.fmtClock(last)}`);
        const durTxt = durRange(list.map(p => {
            const a = mins(p['Start Time']), b = mins(p['End Time']);
            return a == null || b == null ? null : ((b - a) + 1440) % 1440;
        }).filter(d => d));
        const rinks = [...new Set(list.map(p => p.LocationName || ''))].filter(Boolean);
        const short = (n) => n.replace(/\b(Community Recreation Centre|Community Centre|Recreation Centre|Community Arena|Arena|Complex)\b/g, '').replace(/\s+/g, ' ').trim() || n;
        const rinkTxt = rinks.slice(0, 2).map(short).join(', ') + (rinks.length > 2 ? ` +${rinks.length - 2}` : '');
        const types = [...new Set(list.map(p => opts.typeFor && opts.typeFor(p)).filter(Boolean))];
        const saved = list.some(p => opts.isSaved(p));
        const anyLive = list.some(p => opts.statusFor(p).phase === 'live');
        const allEnded = list.every(p => opts.statusFor(p).phase === 'ended');
        const paid = list.filter(p => p.Paid).length;
        let cls = 'cal-block cal-cluster' + (open ? ' open' : '');
        if (saved) cls += ' cal-saved';
        if (anyLive) cls += ' cal-live';
        if (allEnded) cls += ' cal-ended';
        const block = el('button', {
            class: cls, dataset: { cluster: dateKey, hour },
            title: `${list.length} sessions starting ${opts.fmtClock(hour + ':00')}–${opts.fmtClock(hour + ':59')} at ${rinks.length} rink${rinks.length === 1 ? '' : 's'}. Tap to ${open ? 'fold' : 'expand'}.`,
            'aria-expanded': open ? 'true' : 'false'
        });
        block.appendChild(el('span', { class: 'cal-block-time' }, [timeTxt, ...(saved ? [el('span', { class: 'cal-heart', 'aria-label': 'saved' }, [' ♥'])] : [])]));
        block.appendChild(el('span', { class: 'cal-block-title' }, [
            `${list.length} sessions${durTxt ? ' · ' + durTxt : ''} `,
            ...(paid ? [el('span', { class: 'cal-price' }, [paid === list.length ? '· paid ' : `· ${paid} paid `])] : []),
            el('span', { class: 'caret', 'aria-hidden': 'true' }, ['▾'])
        ]));
        block.appendChild(el('span', { class: 'cal-dots' }, types.map(t => el('span', { class: `legend-dot ${t}`, title: t }))));
        block.appendChild(el('span', { class: 'cal-block-loc' }, [rinkTxt]));
        return block;
    }

    /**
     * Render into `container`.
     * opts: {
     *   weekOffset, fmtClock(t), idFor(p), isSaved(p),
     *   alertFor(p) → null|{level}, statusFor(p) → SkateTime.status result,
     *   typeFor(p) → css type class, maxBlocks (default 8)
     * }
     * Returns { label, total, types, states } for the header, nav and
     * legend that app.js owns (types/states = what this week shows).
     */
    function render(container, programs, opts) {
        const start = weekStart(opts.weekOffset || 0);
        const todayKey = T.todayKey();
        const maxBlocks = opts.maxBlocks || 8;

        // bucket programs by date key for this week only
        const byDay = {};
        for (let i = 0; i < 7; i++) byDay[T.addDays(start, i)] = [];
        let total = 0;
        // what the week actually shows, so the legend can stick to it
        const types = new Set(), states = { saved: false, paid: false, closed: false, warning: false, unverified: false };
        programs.forEach(p => {
            const dateKey = String(p['Start Date Time'] || p['Start Date'] || '').slice(0, 10);
            if (!byDay[dateKey]) return;
            byDay[dateKey].push(p); total++;
            const t = opts.typeFor && opts.typeFor(p);
            if (t) types.add(t);
            if (p.Paid) states.paid = true;
            if (p.Unverified) states.unverified = true;
            if (opts.isSaved(p)) states.saved = true;
            const a = opts.alertFor(p);
            if (a) states[a.level === 'closed' ? 'closed' : 'warning'] = true;
        });

        // day strip: the scroll affordance on phones, a quick jump everywhere
        const strip = el('div', { class: 'cal-days', role: 'tablist', 'aria-label': 'Days of this week' });
        Object.entries(byDay).forEach(([dateKey, list], i) => {
            const isToday = dateKey === todayKey;
            strip.appendChild(el('button', {
                class: 'cal-daychip' + (isToday ? ' today' : '') + (list.length ? '' : ' empty'),
                dataset: { scrollDate: dateKey },
                title: `${list.length} session${list.length === 1 ? '' : 's'}`
            }, [
                el('span', { class: 'cal-daychip-name' }, [DAY_LABELS[i]]),
                el('span', { class: 'cal-daychip-num' }, [dateKey.slice(8).replace(/^0/, '')]),
                el('span', { class: 'cal-daychip-count' }, [String(list.length)])
            ]));
        });

        const grid = el('div', { class: 'cal-grid' });
        Object.entries(byDay).forEach(([dateKey, list], i) => {
            const isToday = dateKey === todayKey;
            const col = el('div', { class: 'cal-day' + (isToday ? ' today' : ''), dataset: { date: dateKey } });
            const dayNum = dateKey.slice(8).replace(/^0/, '');
            col.appendChild(el('div', { class: 'cal-day-head' }, [
                el('span', { class: 'cal-day-name' }, [DAY_LABELS[i] + (isToday ? ' · today' : '')]),
                el('span', { class: 'cal-day-num' }, [dayNum])
            ]));

            list.sort((a, b) => T.sortEpoch(a) - T.sortEpoch(b));
            if (!list.length) col.appendChild(el('div', { class: 'cal-empty' }, ['·']));

            if (list.length > maxBlocks) {
                // crowded: fold same-hour starts into time blocks, keep singles as blocks
                const byHour = new Map();
                list.forEach(p => {
                    const h = String(p['Start Time'] || '00:00').slice(0, 2);
                    if (!byHour.has(h)) byHour.set(h, []);
                    byHour.get(h).push(p);
                });
                col.appendChild(el('div', { class: 'cal-crowded' }, [`${list.length} sessions · tap a block to expand`]));
                [...byHour.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([hour, group]) => {
                    if (group.length === 1) { col.appendChild(sessionBlock(group[0], opts)); return; }
                    const open = !!(opts.isOpen && opts.isOpen(dateKey, hour));
                    col.appendChild(clusterBlock(dateKey, hour, group, opts, open));
                    if (open) col.appendChild(el('div', { class: 'cal-cluster-body' }, group.map(p => sessionBlock(p, opts))));
                });
            } else {
                list.forEach(p => col.appendChild(sessionBlock(p, opts)));
            }
            grid.appendChild(col);
        });

        // scroll hint: fades the right edge while more columns hide off-screen
        const wrap = el('div', { class: 'cal-scroll' }, [grid]);
        container.innerHTML = '';
        container.append(strip, wrap);

        // keep today's column in view on narrow screens — synchronous on
        // purpose: layout is final right after insertion, while a rAF
        // callback can be throttled into never running on hidden tabs
        const todayCol = grid.querySelector('.cal-day.today');
        if (todayCol && scrolls(grid)) {
            grid.scrollLeft = Math.max(0, todayCol.offsetLeft - 12);
        }
        wrap.classList.toggle('scrolls', scrolls(grid));
        grid.addEventListener('scroll', () => {
            syncDayStrip(container);
            wrap.classList.toggle('at-end', grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 4);
        }, { passive: true });
        syncDayStrip(container);

        return { label: weekLabel(start), total, types: [...types], states };
    }

    return { render, scrollToDate, syncDayStrip };
})();

if (typeof module !== 'undefined') module.exports = window.SkateCalendar;
