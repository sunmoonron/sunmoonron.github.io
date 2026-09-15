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
 * block hands app.js the date + hour (data attributes), which opens the
 * list for that day. Single sessions in a crowded day stay tappable
 * blocks. Clicking is handled by app.js via delegation (data-pid /
 * data-cluster), same pattern as the program list.
 *
 * Layout: 7 columns that horizontally scroll on small screens; the day
 * strip doubles as the scroll affordance and shows which day is in view.
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

    /** Scroll the grid so `dateKey`'s column is in view (narrow screens). */
    function scrollToDate(container, dateKey) {
        const grid = container.querySelector('.cal-grid');
        const col = grid && grid.querySelector(`.cal-day[data-date="${dateKey}"]`);
        if (!grid || !col) return;
        // instant on purpose: smooth scrolling silently no-ops in some mobile viewports
        grid.scrollLeft = Math.max(0, col.offsetLeft - 12);
        markInView(container, dateKey);
    }

    function markInView(container, dateKey) {
        container.querySelectorAll('.cal-daychip').forEach(c => c.classList.toggle('in-view', c.dataset.scrollDate === dateKey));
    }

    /** Which column is (mostly) in view → highlight its chip. Called on grid scroll. */
    function syncDayStrip(container) {
        const grid = container.querySelector('.cal-grid');
        if (!grid) return;
        const cols = [...grid.querySelectorAll('.cal-day')];
        if (!cols.length) return;
        const x = grid.scrollLeft + Math.min(grid.clientWidth, cols[0].offsetWidth) / 2;
        let best = cols[0];
        cols.forEach(c => { if (c.offsetLeft <= x) best = c; });
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

    /** Several sessions starting in the same hour → one time block. */
    function clusterBlock(dateKey, hour, list, opts) {
        const starts = list.map(p => p['Start Time'] || '').filter(Boolean).sort();
        const ends = list.map(p => p['End Time'] || '').filter(Boolean).sort();
        const timeTxt = opts.fmtClock(starts[0] || '') + (ends.length ? '–' + opts.fmtClock(ends[ends.length - 1]) : '');
        const rinks = [...new Set(list.map(p => p.LocationName || ''))].filter(Boolean);
        const short = (n) => n.replace(/\b(Community Recreation Centre|Community Centre|Recreation Centre|Community Arena|Arena|Complex)\b/g, '').replace(/\s+/g, ' ').trim() || n;
        const rinkTxt = rinks.slice(0, 2).map(short).join(', ') + (rinks.length > 2 ? ` +${rinks.length - 2}` : '');
        const types = [...new Set(list.map(p => opts.typeFor && opts.typeFor(p)).filter(Boolean))];
        const saved = list.some(p => opts.isSaved(p));
        const anyLive = list.some(p => opts.statusFor(p).phase === 'live');
        const allEnded = list.every(p => opts.statusFor(p).phase === 'ended');
        const paid = list.filter(p => p.Paid).length;
        let cls = 'cal-block cal-cluster';
        if (saved) cls += ' cal-saved';
        if (anyLive) cls += ' cal-live';
        if (allEnded) cls += ' cal-ended';
        const block = el('button', {
            class: cls, dataset: { cluster: dateKey, hour },
            title: `${list.length} sessions starting ${opts.fmtClock(hour + ':00')}–${opts.fmtClock(hour + ':59')} at ${rinks.length} rink${rinks.length === 1 ? '' : 's'}. Tap to see them as a list.`
        });
        block.appendChild(el('span', { class: 'cal-block-time' }, [timeTxt, ...(saved ? [el('span', { class: 'cal-heart', 'aria-label': 'saved' }, [' ♥'])] : [])]));
        block.appendChild(el('span', { class: 'cal-block-title' }, [
            `${list.length} sessions`,
            ...(paid ? [el('span', { class: 'cal-price' }, [paid === list.length ? ' paid' : ` ${paid} paid`])] : [])
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
     * Returns { label, total } for the header/nav that app.js owns.
     */
    function render(container, programs, opts) {
        const start = weekStart(opts.weekOffset || 0);
        const todayKey = T.todayKey();
        const maxBlocks = opts.maxBlocks || 8;

        // bucket programs by date key for this week only
        const byDay = {};
        for (let i = 0; i < 7; i++) byDay[T.addDays(start, i)] = [];
        let total = 0;
        programs.forEach(p => {
            const dateKey = String(p['Start Date Time'] || p['Start Date'] || '').slice(0, 10);
            if (byDay[dateKey]) { byDay[dateKey].push(p); total++; }
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
                col.appendChild(el('div', { class: 'cal-crowded' }, [`${list.length} sessions · tap a block for the list`]));
                [...byHour.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([hour, group]) => {
                    col.appendChild(group.length === 1 ? sessionBlock(group[0], opts) : clusterBlock(dateKey, hour, group, opts));
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
        if (todayCol && grid.scrollWidth > grid.clientWidth) {
            grid.scrollLeft = Math.max(0, todayCol.offsetLeft - 12);
        }
        wrap.classList.toggle('scrolls', grid.scrollWidth > grid.clientWidth + 4);
        grid.addEventListener('scroll', () => {
            syncDayStrip(container);
            wrap.classList.toggle('at-end', grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 4);
        }, { passive: true });
        syncDayStrip(container);

        return { label: weekLabel(start), total };
    }

    return { render, weekStart, weekLabel, scrollToDate, syncDayStrip };
})();

if (typeof module !== 'undefined') module.exports = window.SkateCalendar;
