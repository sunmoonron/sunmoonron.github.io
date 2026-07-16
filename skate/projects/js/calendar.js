/**
 * SkateCalendar — the unified week view for planning.
 *
 * A pure renderer: app.js hands it the CURRENT FILTERED programs plus a
 * few callbacks (saved?, alert?, status?, id) and a week offset; it draws
 * a Monday→Sunday grid where every session is a small block. Saved
 * programs glow, paid ones are gold, alert-flagged ones are struck, live
 * ones pulse. Clicking a block is handled by app.js via the data-pid
 * attribute (same delegation pattern as the program list).
 *
 * Layout: 7 columns that horizontally scroll on small screens (each
 * column has a min width) — no separate mobile markup needed.
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

    /**
     * Render into `container`.
     * opts: {
     *   weekOffset, fmtClock(t), idFor(p), isSaved(p),
     *   alertFor(p) → null|{level}, statusFor(p) → SkateTime.status result,
     * }
     * Returns { label, total } for the header/nav that app.js owns.
     */
    function render(container, programs, opts) {
        const start = weekStart(opts.weekOffset || 0);
        const todayKey = T.todayKey();

        // bucket programs by date key for this week only
        const byDay = {};
        for (let i = 0; i < 7; i++) byDay[T.addDays(start, i)] = [];
        let total = 0;
        programs.forEach(p => {
            const dateKey = String(p['Start Date Time'] || p['Start Date'] || '').slice(0, 10);
            if (byDay[dateKey]) { byDay[dateKey].push(p); total++; }
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
            if (!list.length) {
                col.appendChild(el('div', { class: 'cal-empty' }, ['—']));
            }
            list.forEach(p => {
                const saved = opts.isSaved(p);
                const alert = opts.alertFor(p);
                const st = opts.statusFor(p);
                let cls = 'cal-block';
                if (p.Paid) cls += ' cal-paid';
                if (saved) cls += ' cal-saved';
                if (alert) cls += alert.level === 'closed' ? ' cal-closed' : ' cal-warning';
                if (st.phase === 'live') cls += ' cal-live';
                else if (st.phase === 'soon') cls += ' cal-soon';
                else if (st.phase === 'ended') cls += ' cal-ended';
                if (p.Unverified) cls += ' cal-unverified';

                const block = el('button', { class: cls, dataset: { pid: opts.idFor(p) }, title: `${p.Activity || ''} @ ${p.LocationName || ''}` });
                const timeTxt = opts.fmtClock(p['Start Time'] || '') + (p['End Time'] ? '–' + opts.fmtClock(p['End Time']) : '');
                block.appendChild(el('span', { class: 'cal-block-time' }, [
                    timeTxt,
                    ...(p.Paid ? [el('span', { class: 'cal-price' }, [` 💲${p.Price ?? ''}`])] : []),
                    ...(saved ? [el('span', { class: 'cal-heart' }, [' ❤️'])] : [])
                ]));
                block.appendChild(el('span', { class: 'cal-block-title' }, [
                    (alert && alert.level === 'closed' ? '🚫 ' : alert ? '⚠️ ' : '') +
                    (p.Unverified ? '❓ ' : '') +
                    (p.Activity || 'Skating')
                ]));
                block.appendChild(el('span', { class: 'cal-block-loc' }, [p.LocationName || '']));
                col.appendChild(block);
            });
            grid.appendChild(col);
        });

        container.innerHTML = '';
        container.appendChild(grid);

        // keep today's column in view on narrow screens — synchronous on
        // purpose: layout is final right after insertion, while a rAF
        // callback can be throttled into never running on hidden tabs
        const todayCol = grid.querySelector('.cal-day.today');
        if (todayCol && grid.scrollWidth > grid.clientWidth) {
            grid.scrollLeft = Math.max(0, todayCol.offsetLeft - 12);
        }

        return { label: weekLabel(start), total };
    }

    return { render, weekStart, weekLabel };
})();

if (typeof module !== 'undefined') module.exports = window.SkateCalendar;
