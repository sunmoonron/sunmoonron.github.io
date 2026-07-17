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

    /* ================= App state ================= */
    const S = {
        programs: [], filtered: [], page: 1, perPage: 20,
        type: 'all', search: '', day: '', age: null, showPast: false,
        // v2: runtime copies of persisted prefs (S is the source of truth
        // while the app runs; SkateSettings persists explicit user choices)
        paidVisible: !!SkateSettings.get('paidVisible'),
        rinkScope: SkateSettings.get('rinkScope') || 'all',
        sort: SkateSettings.get('sort') || 'time',
        calMode: !!SkateSettings.get('calMode'),
        calWeekOffset: 0,
        nearRink: null,                // {key, name} chip filter set from the 📍 locator
        myRinksReturnScope: null,      // restore scope if picker closes with 0 picks
        pendingExpAction: null,        // continuation for the lazy onboarding gate
        // theme handled by Actions.applyTheme (Settings → Appearance)
        activeGuideId: null, guideCat: '',
        lastVotesSnapshot: '',
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
            if (p['Location ID'] != null) return String(p['Location ID']);
            if (p.Source && p.Source !== 'city') return 'ext-' + p.Source;
            return 'name:' + P.location(p).toLowerCase();
        },

        /** Config-driven type matcher (replaces the hardcoded if-chain). */
        matchesType(p, typeId) {
            const t = CFG.programTypes.find(x => x.id === typeId);
            if (!t || t.special === 'all') return true;
            if (t.special === 'favorites') return SkateChat.Favorites.has(p);
            const a = P.activity(p).toLowerCase();
            return (t.keywords || []).some(k => a.includes(k));
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

    function programText(p) {
        const date = P.dateStr(p) ? parseLocalDate(P.dateStr(p)).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }) : '';
        return `⛸️ ${P.activity(p)}\n📍 ${P.location(p)}\n🗓️ ${date}${P.time(p) ? ' at ' + fmtClock(P.time(p)) : ''}\n\n${baseUrl()}#p=${P.id(p)}`;
    }

    function downloadIcs(p) {
        if (!P.dateStr(p)) return SkateChat.Notify.toast('This program has no date to add', 'error');
        const d = parseLocalDate(P.dateStr(p));
        const [sh, sm] = (P.time(p) || '00:00').split(':').map(Number);
        const [eh, em] = (P.endTime(p) || '').split(':').map(Number);
        const pad = n => String(n).padStart(2, '0');
        const stamp = (h, m) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(h || 0)}${pad(m || 0)}00`;
        const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
        const pid = P.id(p);
        const lines = [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Toronto Skating//EN',
            'BEGIN:VEVENT',
            `UID:${pid}@toronto-skating`,
            `DTSTART:${stamp(sh, sm)}`,
            Number.isFinite(eh) ? `DTEND:${stamp(eh, em)}` : `DTEND:${stamp((sh || 0) + 1, sm)}`,
            `SUMMARY:${esc(P.activity(p) || 'Skating')}`,
            `LOCATION:${esc(P.location(p) + ', Toronto, ON')}`,
            `URL:${baseUrl()}#p=${pid}`,
            'END:VEVENT', 'END:VCALENDAR'
        ];
        const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `skating-${pid}.ics` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        SkateChat.Notify.toast('Calendar file downloaded 📆', 'success', 2000);
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

        // Program type chips (pruned to non-empty categories once data loads)
        Render.typeChips();

        // Rink scope chips (all / mine / edit) — rebuilt on changes
        Render.scopeChips();

        // Day options
        fillSelect($('day-filter'), CFG.days);

        // Sort options
        fillSelect($('sort-filter'), CFG.sortOptions.map(o => ({ value: o.id, label: o.label })), v => v.label);
        $('sort-filter').value = S.sort;

        // Age quick-picks (Kids / Teens / Adults / Seniors + exact input reveal)
        fillSelect($('age-preset'), CFG.agePresets.map(a => ({ value: a.id, label: a.label })), v => v.label);

        // Version chip + unseen-release dot
        $('version-label').textContent = 'v' + CFG.version;
        $('version-dot').classList.toggle('hidden', SkateSettings.get('lastSeenVersion') === CFG.version);

        $('show-paid-toggle').checked = S.paidVisible;

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
        seg($('settings-exp'), CFG.experiences, 'exp');
        seg($('settings-sections'), CFG.sectionToggles, 'vis');

        // Onboarding choices
        const ob = $('onboarding-choices');
        ob.innerHTML = '';
        CFG.experiences.forEach(x => {
            ob.appendChild(el('button', { class: 'onboard-choice', id: `onboard-${x.id}` }, [
                el('span', { class: 'onboard-emoji' }, [x.emoji]),
                el('span', { html: `<strong>${escapeHtml(x.title)}</strong><br><small>${escapeHtml(x.sub)}</small>` })
            ]));
        });
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
        return S.programs.filter(p =>
            P.locKey(p) === key &&
            (S.paidVisible || !p.Paid) &&
            SkateTime.status(p, nowMs).phase !== 'ended').length;
    }

    Render.scopeChips = function () {
        const n = (SkateSettings.get('myRinks') || []).length;
        // "(N)" on All rinks = locations with at least one upcoming session
        // under the current Paid setting — flips live with the toggle.
        const nowMs = Date.now();
        const activeLocs = new Set();
        S.programs.forEach(p => {
            if ((S.paidVisible || !p.Paid) && SkateTime.status(p, nowMs).phase !== 'ended') activeLocs.add(P.locKey(p));
        });
        const items = CFG.rinkScopes.map(s => ({
            ...s,
            label: s.id === 'mine' && n ? `${s.label} (${n})`
                 : s.id === 'all' && activeLocs.size ? `${s.label} (${activeLocs.size})`
                 : s.label
        }));
        items.push({ id: 'edit', label: 'Edit…' });
        if (S.nearRink) items.push({ id: 'nearclear', label: `Only: ${S.nearRink.name} ✕` });

        chips($('scope-row'), items, {
            attr: 'scope', active: S.rinkScope,
            onPick: id => Actions.pickScope(id),
            extra: (btn, it) => {
                if (it.id === 'edit') { btn.classList.add('scope-edit'); btn.title = 'Choose which rinks count as yours'; }
                if (it.id === 'nearclear') { btn.classList.add('scope-near'); btn.title = 'Showing one rink from the locator — tap to clear'; }
            }
        });
    };

    /**
     * Activity-type chips, pruned to categories that actually EXIST in the
     * current dataset — Speed/Adapted/Ringette vanish over the summer and
     * reappear on their own when outdoor-season programming returns.
     * The Saved chip is always shown, ♥-styled, with a live count.
     */
    Render.typeChips = function () {
        const items = CFG.programTypes.filter(t => {
            if (t.special) return true;                                  // All + Saved always
            if (!S.programs.length) return true;                         // pre-data boot: show everything
            return S.programs.some(p => P.matchesType(p, t.id));
        });
        // active type may have just been pruned (e.g. after a data refresh)
        if (!items.some(t => t.id === S.type)) S.type = 'all';

        chips($('type-filters'), items, {
            attr: 'type', active: S.type,
            onPick: id => { S.type = id; Actions.applyFilters(); },
            extra: (btn, it) => {
                if (it.special !== 'favorites') return;
                btn.classList.add('chip-saved');
                btn.textContent = '';
                btn.append(
                    el('span', { class: 'chip-heart', 'aria-hidden': 'true' }, ['♥']),
                    document.createTextNode(' Saved')
                );
                const count = SkateChat.Favorites.count();
                if (count) btn.appendChild(el('span', { class: 'chip-count' }, [String(count)]));
                btn.title = count ? `${count} saved session${count === 1 ? '' : 's'}` : 'Sessions you saved with the heart button';
            }
        });
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
    Render.dataWarnings = function (metadata, now) {
        const wrap = $('data-warnings');
        wrap.innerHTML = '';
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
        const { filtered, page, perPage } = S;
        const start = (page - 1) * perPage;
        const items = filtered.slice(start, start + perPage);
        const chatState = SkateChat.getState();
        const now = new Date();

        // stats line (shared by list + calendar views). The paid toggle and
        // its "hidden" hint reflect the FULL current filter set (rinks, type,
        // day, age, search) — they only appear when toggling Paid would
        // actually change what's on screen. If Paid is ON, the toggle stays
        // visible even at zero matches so it can be turned back off.
        const paidMatching = S.paidMatching || 0;
        $('paid-toggle-wrap').classList.toggle('hidden', paidMatching === 0 && !S.paidVisible);
        const paidHidden = !S.paidVisible ? paidMatching : 0;
        $('stats-text').textContent = `${filtered.length} sessions` + (paidHidden ? ` · ${paidHidden} paid hidden` : '');
        const metadata = SkateAPI.getMetadata();
        Render.dataWarnings(metadata, now);
        if (metadata?.lastUpdated) {
            const updated = new Date(metadata.lastUpdated);
            const daysAgo = Math.floor((now - updated) / 86400000);
            const dateStr = updated.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
            $('data-updated').textContent = daysAgo === 0 ? 'Updated today' : daysAgo === 1 ? 'Updated yesterday' : `Updated ${dateStr}`;
            $('data-updated').classList.toggle('stale', daysAgo > 7);
            if (SkateAlerts.fetchedAt) $('data-updated').title = `Service-alert snapshot: ${new Date(SkateAlerts.fetchedAt).toLocaleString('en-CA')}`;
        }

        Render.savedNext();

        // list ↔ week (segmented switch)
        $$('#view-mode-seg button').forEach(b => b.classList.toggle('active', (b.dataset.mode === 'week') === S.calMode));
        $('calendar-wrap').classList.toggle('hidden', !S.calMode);
        $('program-list').classList.toggle('hidden', S.calMode);
        $('pagination').classList.toggle('hidden', S.calMode);
        $('pagination-top').classList.toggle('hidden', S.calMode);
        if (S.calMode) return Render.calendar();

        if (!filtered.length) {
            const empty = S.type === 'favorites' ? 'Nothing saved yet — tap the heart on any session to keep it here.'
                : S.rinkScope === 'mine' ? 'Nothing at your rinks with these filters — switch to "All rinks" to widen the search.'
                : 'No matching sessions found';
            $('program-list').innerHTML = `<li class="loading">${empty}</li>`;
            Render.pagination(0);
            return;
        }

        $('program-list').innerHTML = items.map((p, i) => Render.programRow(p, start + i, chatState, now)).join('');
        Render.pagination(Math.ceil(filtered.length / perPage));
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

        let dateDisplay = '';
        if (P.dateStr(p)) {
            dateDisplay = parseLocalDate(P.dateStr(p)).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
        }

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

        // Service alert verdict for this location (toronto.ca snapshot)
        const alert = SkateAlerts.forProgram(p);
        let alertHtml = '';
        if (alert) {
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

        // Paid venue extras: gold badge with price + register link
        const srcInfo = CFG.sourceInfo[p.Source];
        const paidBadge = p.Paid ? `<span class="paid-badge" title="Paid venue${srcInfo ? ' — ' + escapeHtml(srcInfo.label) : ''}${srcInfo?.note ? '. ' + escapeHtml(srcInfo.note) : ''}">$${p.Price != null ? p.Price : '?'}</span>` : '';
        const srcTag = (p.Source && p.Source !== 'city' && srcInfo) ? `<span class="src-tag" title="${escapeHtml(srcInfo.note || '')}">via ${escapeHtml(srcInfo.label)}</span>` : '';
        const registerBtn = (p.Paid && p.RegistrationUrl) ? `<a class="btn-register" href="${escapeHtml(p.RegistrationUrl)}" target="_blank" rel="noopener" title="Opens the venue's registration page">Register ↗</a>` : '';

        // Live spots (fetched from the venue's registration API in-browser)
        const live = p.Paid ? SkateLive.forProgram(p) : null;
        let spotsBadge = '';
        if (live) {
            if (live.status && live.status !== 'open' && st.phase !== 'ended') {
                spotsBadge = '<span class="spots-badge closed-reg" title="The venue\'s online registration for this session is closed">Registration closed</span>';
            } else if (live.open != null) {
                spotsBadge = `<span class="spots-badge${live.open <= 20 ? ' low' : ''}" title="Live from the venue's registration system">${live.open}${live.capacity ? '/' + live.capacity : ''} spots left</span>`;
            }
        }

        // Distance badge once a location is set via the 📍 locator
        const km = SkateGeo.distanceForProgram(p);
        const distBadge = km != null ? `<div class="dist-badge">📍 ${SkateGeo.fmtKm(km)}</div>` : '';

        // Per-location footnote (e.g. Don Montgomery's on-site rink-info TV)
        const note = CFG.locationNotes[String(p['Location ID'] ?? '')];
        const noteBtn = note ? `<button class="loc-note" data-note="${escapeHtml(note)}" title="${escapeHtml(note)}" aria-label="Location note">ℹ️</button>` : '';

        // Action buttons from config. The vote button is ALWAYS rendered —
        // it used to vanish without an active group, which read as a bug
        // (classic case: iOS home-screen apps get separate storage, so the
        // installed app had no group and the button "disappeared"). Now a
        // group-less tap explains how voting works instead.
        const votes = SkateChat.getVotes(p);
        const isFavorite = SkateChat.Favorites.has(p);
        const actionHtml = CFG.programActions.map(a => {
            let title = a.title || '', text = a.text || '', extraCls = '';
            if (a.act === 'fav') {
                title = isFavorite ? 'Remove from saved' : 'Save this program';
                text = isFavorite ? '❤️' : '🤍';
                extraCls = isFavorite ? ' active' : '';
            } else if (a.act === 'vote') {
                title = chatState.activeGroup
                    ? `Vote for this time with ${escapeHtml(chatState.activeGroup.name)}`
                    : 'Vote for this time with a group — open Chats to join or create one';
                text = `👍 ${votes.count || ''}`;
                extraCls = (votes.mine ? ' voted' : '') + (chatState.activeGroup ? '' : ' inactive');
            }
            return `<button data-act="${a.act}" data-idx="${idx}" class="${a.cls}${extraCls}" title="${title}">${text}</button>`;
        }).join('');

        const locationHtml = location ? `<a href="${mapsUrl(location)}" target="_blank" rel="noopener" class="program-location">📍 ${escapeHtml(location)} ↗</a>${noteBtn}` : '';

        return `
            <li class="program-item${rowStateCls}${p.Paid ? ' is-paid' : ''}${isFavorite ? ' is-saved' : ''}${alert ? (alert.level === 'closed' ? ' has-alert-closed' : ' has-alert') : ''}" data-pid="${pid}">
                <div class="program-header">
                    <div>
                        <div class="program-title">${escapeHtml(activity)}</div>
                        ${locationHtml}
                    </div>
                    <div class="program-meta">
                        ${statusChip}
                        <div class="program-date">${dateDisplay}</div>
                        <div>${fmtClock(time)}${endTime ? '–' + fmtClock(endTime) : ''}</div>
                        ${distBadge}
                    </div>
                </div>
                ${alertHtml}${unverifiedHtml}
                <div class="program-footer">
                    <div class="program-badges">${P.tagFor(p)} ${paidBadge} ${spotsBadge} ${P.ageBadge(p)} ${srcTag}</div>
                    <div class="program-actions">${registerBtn}${actionHtml}</div>
                </div>
            </li>`;
    };

    Render.pagination = function (totalPages) {
        const html = totalPages <= 1 ? '' : (() => {
            const { page } = S;
            let h = `<button ${page === 1 ? 'disabled' : ''} data-p="${page - 1}">‹</button>`;
            for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) {
                h += `<button class="${i === page ? 'active' : ''}" data-p="${i}">${i}</button>`;
            }
            h += `<button ${page === totalPages ? 'disabled' : ''} data-p="${page + 1}">›</button>`;
            return h;
        })();
        $('pagination').innerHTML = html;
        $('pagination-top').innerHTML = html;
    };

    /* ---------- Chats: unified list + conversation ---------- */
    Render.chatUI = function (chatState) {
        const totalUnread = (chatState.totalGroupUnread || 0) + (chatState.totalDmUnread || 0);
        $('chats-badge').textContent = totalUnread;
        $('chats-badge').classList.toggle('hidden', !totalUnread);
        $('user-name').textContent = `👤 ${chatState.myName || 'Guest'}`;

        Render.conversations(chatState);
        Render.activeChat(chatState);
        Render.discoverRooms(chatState);
        Render.mutedList();

        // Programs re-render ONLY when votes actually changed
        const votesSnapshot = JSON.stringify(Object.values(chatState.groups).map(g => g.votes || {})) + '|' + (chatState.activeGroupId || '');
        if (votesSnapshot !== S.lastVotesSnapshot) {
            S.lastVotesSnapshot = votesSnapshot;
            Render.programs();
        }
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
            ? `<div class="sender" ${m.fromPubkey ? `data-pk="${m.fromPubkey}"` : ''} data-name="${escapeHtml(m.from || 'Skater')}" title="Tap for message / mute">${!isDm ? hueDot(m.fromPubkey) : ''}${escapeHtml(m.from || '')}</div>`
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

    Render.mutedList = function () {
        const list = $('muted-list');
        const muted = SkateChat.Mutes.list();
        list.innerHTML = '';
        if (!muted.length) {
            list.appendChild(el('li', { class: 'muted-empty' }, ['No one muted. Tap a name in any chat to mute someone.']));
            return;
        }
        muted.forEach(m => {
            const label = el('span', { html: hueDot(m.pubkey) });
            label.append(document.createTextNode(`${m.name} `), el('span', { class: 'pk-tag' }, [shortPk(m.pubkey)]));
            list.appendChild(el('li', {}, [
                label,
                el('button', { class: 'btn-small', onclick: () => SkateChat.Mutes.toggle(m.pubkey, m.name) }, ['🔊 Unmute'])
            ]));
        });
    };

    Render.settings = function () {
        const fmt = SkateSettings.get('timeFormat'), exp = SkateSettings.get('experience');
        const theme = themeSetting();   // resolved: unchosen 'system' shows as Light
        $$('#settings-timefmt button').forEach(b => b.classList.toggle('active', b.dataset.fmt === fmt));
        $$('#settings-theme button').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
        $$('#settings-exp button').forEach(b => b.classList.toggle('active', b.dataset.exp === exp));
        $$('#settings-sections button').forEach(b => b.classList.toggle('active', SkateSettings.get(b.dataset.vis) !== false));
        Render.notif();
        Render.mutedList();
    };

    Render.notif = function () {
        const p = SkateChat.Notify.permission();
        const btn = $('btn-enable-notif'), hint = $('notif-hint');
        if (p === 'granted') { btn.classList.add('hidden'); hint.textContent = 'Enabled ✓ — you\'ll be pinged for messages while this tab is in the background.'; }
        else if (p === 'denied') { btn.classList.add('hidden'); hint.textContent = 'Blocked in your browser — allow notifications for this site in browser settings to turn them on.'; }
        else if (p === 'unsupported') { btn.classList.add('hidden'); hint.textContent = 'Your browser doesn\'t support notifications.'; }
        else { btn.classList.remove('hidden'); hint.textContent = 'Get pinged for new messages when this tab is in the background.'; }
    };

    /* ---------- Locator (closest rinks) ---------- */
    Render.locator = function () {
        const user = SkateGeo.getUserLocation();
        $('locator-status').textContent = user ? `Rinks nearest to: ${user.label}` : '';
        const wrap = $('locator-results');
        wrap.innerHTML = '';
        if (!user) {
            wrap.appendChild(el('p', { class: 'settings-hint' }, ['Share your location or search an address to see your closest rinks, with distances everywhere in the app.']));
            return;
        }
        if (!SkateGeo.loaded || !SkateGeo.rinks.length) {
            wrap.appendChild(el('p', { class: 'settings-hint' }, ['Rink map still loading — try again in a second.']));
            return;
        }
        const mine = new Set(SkateSettings.get('myRinks') || []);
        SkateGeo.nearest(user, 12).forEach(r => {
            const key = String(r.locationid);
            const sessions = upcomingCountFor(key);
            const alerts = SkateAlerts.forLocation(key);
            const row = el('div', { class: 'locator-rink' });
            row.appendChild(el('div', { class: 'locator-rink-info' }, [
                el('strong', {}, [
                    r.name,
                    ...(r.paid ? [el('span', { class: 'paid-badge small' }, [' 💲'])] : []),
                    ...(alerts.length ? [el('span', { class: 'locator-alert', title: alerts.map(a => a.Reason).join(', ') }, [' ⚠️'])] : [])
                ]),
                el('span', { class: 'locator-rink-meta' }, [
                    `${SkateGeo.fmtKm(r.km)} · ${(r.kinds || []).map(k => k === 'indoor' ? '🏠 indoor' : '🌳 outdoor').join(' + ')}` +
                    (sessions ? ` · ${sessions} upcoming` : ' · no drop-ins listed')
                ])
            ]));
            const starred = mine.has(key);
            row.appendChild(el('div', { class: 'locator-rink-actions' }, [
                el('button', { class: 'btn-small', dataset: { locFilter: key, locName: r.name }, title: 'Show only this rink\'s sessions' }, ['Filter']),
                el('button', { class: 'btn-small' + (starred ? ' starred' : ''), dataset: { locStar: key }, title: starred ? 'Remove from My rinks' : 'Add to My rinks' }, [starred ? '★ Mine' : '☆ Add'])
            ]));
            wrap.appendChild(row);
        });
    };

    /* ---------- My rinks picker ---------- */
    Render.myRinks = function (filterText = '') {
        const mine = new Set(SkateSettings.get('myRinks') || []);
        $('myrinks-count').textContent = mine.size ? `${mine.size} picked.` : '';
        const user = SkateGeo.getUserLocation();

        // Universe = every rink + every program location (some drop-in spots
        // aren't rinks, e.g. gym ball-hockey — still selectable).
        const seen = new Map();
        SkateGeo.rinks.forEach(r => {
            seen.set(String(r.locationid), {
                key: String(r.locationid), name: r.name,
                km: user && r.lat != null ? SkateGeo.distanceKm(user, { lat: r.lat, lng: r.lng }) : null,
                kinds: r.kinds || []
            });
        });
        S.programs.forEach(p => {
            const key = P.locKey(p);
            if (!seen.has(key)) {
                const km = SkateGeo.distanceForProgram(p);
                seen.set(key, { key, name: P.location(p) || key, km, kinds: [] });
            }
        });

        let all = [...seen.values()];
        const q = filterText.trim().toLowerCase();
        if (q) all = all.filter(x => x.name.toLowerCase().includes(q));
        all.sort((a, b) =>
            (mine.has(b.key) - mine.has(a.key)) ||             // picked first
            ((a.km ?? Infinity) - (b.km ?? Infinity)) ||        // then nearest
            a.name.localeCompare(b.name));                      // then A-Z

        const list = $('myrinks-list');
        list.innerHTML = '';
        all.slice(0, 80).forEach(x => {
            const li = el('li', { class: 'myrinks-item' + (mine.has(x.key) ? ' picked' : ''), dataset: { rink: x.key } });
            li.appendChild(el('span', { class: 'myrinks-check' }, [mine.has(x.key) ? '⭐' : '☆']));
            li.appendChild(el('span', { class: 'myrinks-name' }, [x.name]));
            // session count so nobody picks a location that's empty right now
            const cnt = upcomingCountFor(x.key);
            li.appendChild(el('span', { class: 'myrinks-count' + (cnt ? '' : ' zero') }, [`${cnt} session${cnt === 1 ? '' : 's'}`]));
            li.appendChild(el('span', { class: 'myrinks-meta' }, [x.km != null ? SkateGeo.fmtKm(x.km) : '']));
            list.appendChild(li);
        });
        if (!all.length) list.appendChild(el('li', { class: 'muted-empty' }, ['No locations match that filter.']));
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

        programCopy(p) {
            const items = [
                { ...A('copyDetails'), onClick: () => copyText(programText(p)) },
                { ...A('copyLink'), onClick: () => copyText(`${baseUrl()}#p=${P.id(p)}`, 'Link copied! 🔗') },
                { ...A('addCalendar'), onClick: () => downloadIcs(p) }
            ];
            // Share rides the community stack — only offered when Chats are on
            if (SkateSettings.get('showChats') !== false) {
                items.push({ label: '📤 Share to chat…', onClick: () => Actions.openSharePicker({ type: 'program', payload: p }) });
            }
            return items;
        },

        /** Tapping a session block in the week calendar. */
        calBlock(p) {
            const fav = SkateChat.Favorites.has(p);
            const items = [
                { label: fav ? '💔 Remove from saved' : '❤️ Save this session', onClick: () => { SkateChat.Favorites.toggle(p); Render.typeChips(); Render.programs(); } },
                { label: '📋 Show in list', onClick: () => {
                    S.calMode = false;
                    SkateSettings.set('calMode', false);
                    Render.programs();
                    Actions.focusProgram(P.id(p));
                } }
            ];
            if (p.Paid && p.RegistrationUrl) {
                items.push({ label: '🎟 Register on venue site ↗', onClick: () => window.open(p.RegistrationUrl, '_blank', 'noopener') });
            }
            // programCopy already appends the chats-gated "Share to chat…"
            items.push(...Menus.programCopy(p));
            return items;
        }
    };

    /* ================= Actions (named intents) ================= */
    const Actions = {};

    Actions.switchView = view => Render.switchView(view);

    /**
     * @param keepPage true for background re-runs (the 1-minute status
     * ticker) — keeps the reader's current page instead of jumping to 1.
     */
    Actions.applyFilters = function (keepPage = false) {
        const mine = new Set(SkateSettings.get('myRinks') || []);
        const inScope = (p) =>
            (S.rinkScope !== 'mine' || !mine.size || mine.has(P.locKey(p))) &&
            (!S.nearRink || P.locKey(p) === S.nearRink.key);

        let result = S.programs.filter(p => P.matchesType(p, S.type) && inScope(p));

        if (S.search) {
            const term = S.search.toLowerCase();
            // Postal codes compare space-insensitively ("M5A3S5" finds "M5A 3S5")
            const postalTerm = term.replace(/\s+/g, '');
            result = result.filter(p =>
                P.activity(p).toLowerCase().includes(term) ||
                P.location(p).toLowerCase().includes(term) ||
                (p.Address || '').toLowerCase().includes(term) ||
                (postalTerm && (p.PostalCode || '').toLowerCase().replace(/\s+/g, '').includes(postalTerm)));
        }
        if (S.day) result = result.filter(p => p['Day of Week'] === S.day);
        // Parsed bounds so a stray "None"/"" can never silently exclude a row
        if (S.age !== null) result = result.filter(p =>
            S.age >= (P.age(p['Age Min']) ?? 0) && S.age <= (P.age(p['Age Max']) ?? 999));

        // Past filter on the real END time in Toronto — an event disappears
        // the minute it ends (not at midnight), and in-progress ones stay.
        if (!S.showPast) {
            const nowMs = Date.now();
            result = result.filter(p => SkateTime.status(p, nowMs).phase !== 'ended');
        }

        // Paid exclusion runs LAST so the "N paid hidden" hint (and the
        // toggle's visibility) reflect every other active filter — with
        // Hockey picked or a day with no paid sessions, no phantom "17
        // paid hidden" can appear.
        S.paidMatching = result.filter(p => p.Paid).length;
        if (!S.paidVisible) result = result.filter(p => !p.Paid);

        // Order by actual start instant (date+time, Toronto) — fixes the
        // old date-only sort that shuffled same-day events.
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

        S.filtered = result;
        const maxPage = Math.max(1, Math.ceil(result.length / S.perPage));
        S.page = keepPage ? Math.min(S.page, maxPage) : 1;
        Render.programs();
    };

    Actions.focusProgram = function (pid) {
        const find = () => S.filtered.findIndex(p => P.id(p) === pid);
        let idx = find();
        if (idx === -1) {
            // widen the net: clear filters, include past + paid, all rinks.
            // (session-only — the persisted prefs are untouched)
            S.type = 'all'; S.search = ''; S.day = ''; S.age = null; S.showPast = true;
            S.paidVisible = true; S.rinkScope = 'all'; S.nearRink = null;
            $('search-input').value = ''; $('day-filter').value = ''; $('age-filter').value = '';
            $('age-preset').value = ''; $('age-filter').classList.add('hidden');
            $('show-past-toggle').checked = true;
            $('show-paid-toggle').checked = true;
            $$('#type-filters .filter-chip').forEach(c => c.classList.toggle('active', c.dataset.type === 'all'));
            Render.scopeChips();
            Actions.applyFilters();
            idx = find();
        }
        if (idx === -1) return SkateChat.Notify.toast('That program isn\'t in the current dataset anymore', 'error');
        if (S.calMode) { S.calMode = false; Render.programs(); }
        S.page = Math.floor(idx / S.perPage) + 1;
        Render.programs();
        requestAnimationFrame(() => flash(document.querySelector(`.program-item[data-pid="${pid}"]`)));
    };

    /* ---------- Rink scope + personalization ---------- */
    Actions.pickScope = function (id) {
        if (id === 'edit') {
            Actions.openMyRinks(false);
            Render.scopeChips();   // undo the chip auto-highlight on ✎
            return;
        }
        if (id === 'nearclear') {
            S.nearRink = null;
            Render.scopeChips();
            Actions.applyFilters();
            return;
        }
        if (id === 'mine' && !(SkateSettings.get('myRinks') || []).length) {
            // nothing picked yet — open the picker; scope flips on Done
            Actions.openMyRinks(true);
            Render.scopeChips();
            return;
        }
        S.rinkScope = id;
        SkateSettings.set('rinkScope', id);
        Render.scopeChips();
        Actions.applyFilters();
    };

    Actions.openMyRinks = function (activateOnDone) {
        S.myRinksReturnScope = activateOnDone ? 'activate' : null;
        $('myrinks-search').value = '';
        Render.myRinks('');
        Modal.open('myrinks-modal');
    };

    Actions.toggleMyRink = function (key) {
        const mine = new Set(SkateSettings.get('myRinks') || []);
        mine.has(key) ? mine.delete(key) : mine.add(key);
        SkateSettings.set('myRinks', [...mine]);
        Render.myRinks($('myrinks-search').value);
        Render.scopeChips();
        if (S.rinkScope === 'mine') Actions.applyFilters();
    };

    Actions.closeMyRinks = function () {
        const n = (SkateSettings.get('myRinks') || []).length;
        if (S.myRinksReturnScope === 'activate' && n) {
            S.rinkScope = 'mine';
            SkateSettings.set('rinkScope', 'mine');
        }
        if (!n && S.rinkScope === 'mine') {
            S.rinkScope = 'all';
            SkateSettings.set('rinkScope', 'all');
        }
        S.myRinksReturnScope = null;
        Modal.close('myrinks-modal');
        Render.scopeChips();
        Actions.applyFilters();
    };

    /* ---------- Locator ---------- */
    Actions.openLocator = function () {
        Render.locator();
        Modal.open('locator-modal');
    };

    Actions.useMyLocation = async function () {
        const btn = $('btn-share-location');
        btn.disabled = true; btn.textContent = '📡 Locating…';
        try {
            const loc = await SkateGeo.locateMe();
            SkateGeo.setUserLocation(loc);
            Render.locator();
            Actions.applyFilters(true);
        } catch (e) {
            $('locator-status').textContent = e.message;
        }
        btn.disabled = false; btn.textContent = '📡 Use my location';
    };

    Actions.searchLocation = async function () {
        const btn = $('btn-locator-search');
        btn.disabled = true;
        $('locator-status').textContent = 'Searching…';
        try {
            const loc = await SkateGeo.geocode($('locator-input').value);
            SkateGeo.setUserLocation(loc);
            Render.locator();
            Actions.applyFilters(true);
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
        if (rink && rink.paid) { S.paidVisible = true; $('show-paid-toggle').checked = true; }
        Modal.close('locator-modal');
        Render.scopeChips();
        Actions.applyFilters();
        SkateChat.Notify.toast(`Showing only ${name} — tap the 📍 chip to clear`, 'info', 3500);
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
    };

    /* ---------- What's new ---------- */
    Actions.openWhatsNew = function () {
        Render.whatsNew();
        SkateSettings.set('lastSeenVersion', CFG.version);
        $('version-dot').classList.add('hidden');
        Modal.open('whatsnew-modal');
    };

    /* ---------- Lazy onboarding gate ----------
       The old startup popup is gone. The experience question only appears
       the first time someone actually uses a community feature (chat send,
       guide write, guide comment) — and choosing/skipping never yanks the
       view away from what they were doing. */
    Actions.ensureExperience = function (cont) {
        if (SkateSettings.get('experience')) return cont();
        S.pendingExpAction = cont;
        Modal.open('onboarding-modal');
    };

    Actions.resolveExperience = function (exp) {
        SkateSettings.set('experience', exp);
        Modal.close('onboarding-modal');
        if (exp === 'new') {
            SkateChat.Notify.toast('Welcome! The 📖 Guides tab has first-lap tips, and the 🐣 New Skaters room is judgement-free 🐣', 'success', 4500);
        }
        const cont = S.pendingExpAction;
        S.pendingExpAction = null;
        if (cont) cont();
    };

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
        if (!SkateSettings.get('experience')) return Actions.ensureExperience(() => Actions.submitGuideComment());
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
        // first community action → one-time experience question (input keeps its text)
        if (!SkateSettings.get('experience')) return Actions.ensureExperience(() => Actions.sendCurrent());
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

    /* ---------- Experience / settings / dark mode ---------- */
    Actions.applyExperience = function (exp) {
        SkateSettings.set('experience', exp);
        if (exp === 'new') {
            S.type = 'leisure';
            $$('#type-filters .filter-chip').forEach(c => c.classList.toggle('active', c.dataset.type === 'leisure'));
            Actions.applyFilters();
            Actions.switchView('guides');
            SkateChat.Notify.toast('Set up for new skaters — guides first, leisure sessions filtered 🐣', 'success', 3500);
        } else {
            Actions.switchView('programs');
            SkateChat.Notify.toast('Straight to the schedule 🏒', 'success', 2500);
        }
    };

    Actions.openSettings = function () {
        $('settings-name').value = SkateChat.getState().myName || '';
        Render.settings();
        Modal.open('settings-modal');
    };

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

    Actions.refreshPrograms = async function () {
        $('btn-refresh').disabled = true; $('btn-refresh').textContent = 'Refreshing…';
        try {
            SkateAPI._skatingPrograms = null;
            S.programs = (await SkateAPI.getSkatingPrograms(true)) || [];   // force: bypass HTTP cache
            Render.typeChips();
            Render.scopeChips();
            SkateAlerts.load();                 // re-pull the alert snapshot too
            SkateLive.load(S.programs, true);   // force-refresh live spots
            Actions.applyFilters();
            // The success/failure story belongs to the city-refresh request —
            // no premature "reloaded!" that survives a cancelled confirm.
            const res = await SkateRefresh.requestCityRefresh();   // toasts on queued/failed itself
            if (res === 'cancelled') {
                SkateChat.Notify.toast('No city refresh requested — showing the latest published schedule', 'info', 2500);
            }
        } catch (e) { SkateChat.Notify.toast('Refresh failed: ' + e.message, 'error'); }
        finally { $('btn-refresh').disabled = false; $('btn-refresh').textContent = 'Refresh'; }
    };

    /* ================= Bindings ================= */
    function bind() {
        // Programs
        $('btn-search').onclick = () => { S.search = $('search-input').value.trim(); Actions.applyFilters(); };
        $('search-input').onkeypress = e => { if (e.key === 'Enter') { S.search = $('search-input').value.trim(); Actions.applyFilters(); } };
        $('btn-refresh').onclick = Actions.refreshPrograms;
        $('day-filter').onchange = () => { S.day = $('day-filter').value; Actions.applyFilters(); };
        $('age-preset').onchange = () => {
            const v = $('age-preset').value;
            if (v === 'exact') {
                // reveal the precise input; filter applies as they type
                $('age-filter').classList.remove('hidden');
                $('age-filter').focus();
                S.age = $('age-filter').value ? parseInt($('age-filter').value) : null;
            } else {
                $('age-filter').classList.add('hidden');
                $('age-filter').value = '';
                S.age = v ? parseInt(v) : null;
            }
            Actions.applyFilters();
        };
        $('age-filter').onchange = () => { S.age = $('age-filter').value ? parseInt($('age-filter').value) : null; Actions.applyFilters(); };
        $('show-past-toggle').onchange = () => { S.showPast = $('show-past-toggle').checked; Actions.applyFilters(); };
        $('show-paid-toggle').onchange = () => {
            S.paidVisible = $('show-paid-toggle').checked;
            SkateSettings.set('paidVisible', S.paidVisible);
            Actions.applyFilters();
            Render.scopeChips();   // "(N)" location counts follow the Paid setting
            if (!$('myrinks-modal').classList.contains('hidden')) Render.myRinks($('myrinks-search').value);
        };
        $('sort-filter').onchange = () => {
            S.sort = $('sort-filter').value;
            SkateSettings.set('sort', S.sort);
            if (S.sort === 'near' && !SkateGeo.getUserLocation()) Actions.openLocator();
            Actions.applyFilters();
        };
        $('btn-near').onclick = Actions.openLocator;
        $('saved-next').onclick = () => {
            const pid = $('saved-next').dataset.pid;
            if (pid) Actions.focusProgram(pid);
        };

        // List ↔ Week segmented switch
        delegate($('view-mode-seg'), [
            ['button[data-mode]', (b) => {
                const week = b.dataset.mode === 'week';
                if (week === S.calMode) return;
                S.calMode = week;
                SkateSettings.set('calMode', S.calMode);
                Render.programs();
            }]
        ]);
        $('btn-cal-prev').onclick = () => { S.calWeekOffset--; Render.calendar(); };
        $('btn-cal-next').onclick = () => { S.calWeekOffset++; Render.calendar(); };
        $('btn-cal-today').onclick = () => { S.calWeekOffset = 0; Render.calendar(); };
        delegate($('calendar-view'), [
            ['.cal-block', (block, e) => {
                e.stopPropagation();
                const p = S.filtered.find(x => P.id(x) === block.dataset.pid);
                if (p) Popover.open(block, Menus.calBlock(p));
            }]
        ]);

        // Locator modal
        $('btn-locator-close').onclick = () => Modal.close('locator-modal');
        $('btn-share-location').onclick = Actions.useMyLocation;
        $('btn-locator-search').onclick = Actions.searchLocation;
        $('locator-input').onkeypress = e => { if (e.key === 'Enter') Actions.searchLocation(); };
        delegate($('locator-results'), [
            ['[data-loc-filter]', (b) => Actions.filterToRink(b.dataset.locFilter, b.dataset.locName)],
            ['[data-loc-star]', (b) => { Actions.toggleMyRink(b.dataset.locStar); Render.locator(); }]
        ]);

        // My rinks modal
        $('btn-myrinks-close').onclick = Actions.closeMyRinks;
        $('btn-myrinks-done').onclick = Actions.closeMyRinks;
        $('btn-myrinks-clear').onclick = () => {
            SkateSettings.set('myRinks', []);
            Render.myRinks($('myrinks-search').value);
            Render.scopeChips();
        };
        $('myrinks-search').oninput = () => Render.myRinks($('myrinks-search').value);
        delegate($('myrinks-list'), [
            ['.myrinks-item', (li) => Actions.toggleMyRink(li.dataset.rink)]
        ]);

        // What's new
        $('btn-version').onclick = Actions.openWhatsNew;
        $('btn-whatsnew-close').onclick = () => Modal.close('whatsnew-modal');

        // First-visit setup
        $('setup-done').onclick = Actions.finishSetup;
        $('setup-nearest').onclick = async () => {
            const btn = $('setup-nearest');
            btn.disabled = true; btn.textContent = '📡 Locating…';
            try {
                const loc = await SkateGeo.locateMe();
                SkateGeo.setUserLocation(loc);
                S.sort = 'near';
                SkateSettings.set('sort', 'near');
                $('sort-filter').value = 'near';
                $('setup-rink-status').textContent = '✓ Got it — sessions will sort by distance from you.';
                Actions.applyFilters(true);
            } catch (e) {
                $('setup-rink-status').textContent = e.message;
            }
            btn.disabled = false; btn.textContent = '📡 Find nearest';
        };
        $('setup-pick').onclick = () => { Actions.finishSetup(); Actions.openMyRinks(true); };

        // Single button — the old <label>-wrapped version double-fired.
        // Appearance segment (Settings modal)
        delegate($('settings-theme'), [
            ['button[data-theme]', (b) => {
                SkateSettings.set('theme', b.dataset.theme);
                Actions.applyTheme();
                Render.settings();
            }]
        ]);

        const goPage = (hit) => {
            if (hit.dataset.p) { S.page = parseInt(hit.dataset.p); Render.programs(); $('programs-panel').scrollTop = 0; }
        };
        delegate($('pagination'), [['button[data-p]', goPage]]);
        delegate($('pagination-top'), [['button[data-p]', goPage]]);

        delegate($('program-list'), [
            ['.loc-note', (n, e) => { e.stopPropagation(); SkateChat.Notify.toast(n.dataset.note, 'info', 6000); }],
            ['button[data-act]', (btn) => {
                const p = S.filtered[parseInt(btn.dataset.idx)];
                if (!p) return;
                const act = btn.dataset.act;
                if (act === 'fav') { SkateChat.Favorites.toggle(p); Render.typeChips(); Render.programs(); }
                else if (act === 'vote') {
                    if (SkateChat.getState().activeGroup) SkateChat.voteTime(p);
                    else SkateChat.Notify.toast('Voting is for planning with friends — open Chats and join or create a group first 👍', 'info', 4500);
                }
                else if (act === 'copy') Popover.open(btn, Menus.programCopy(p));
            }]
        ]);

        // Chats — list
        $('btn-discover').onclick = () => Modal.open('discover-modal');
        delegate($('conversation-list'), [
            ['.conv-item', (row) => Actions.openConversation(row.dataset.kind, row.dataset.id)]
        ]);

        // Chats — conversation
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
                const s = SkateChat.getState();
                const m = findMessage(s, msgEl.dataset.local || msgEl.dataset.mid);
                if (!m) return;
                e.stopPropagation();
                Popover.open(msgEl.querySelector('.bubble') || msgEl, Menus.message(m, s));
            }]
        ]);

        // Discover modal
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

        // Invite modal
        $('btn-invite-join').onclick = Actions.confirmInvite;
        $('invite-pw-input').onkeypress = e => { if (e.key === 'Enter') Actions.confirmInvite(); };
        $('btn-invite-cancel').onclick = Actions.dismissInvite;
        $('btn-invite-close').onclick = Actions.dismissInvite;

        // Share modal
        $('btn-share-close').onclick = () => { S.shareCtx = null; Modal.close('share-modal'); };
        $('btn-share-discover').onclick = () => { Modal.close('share-modal'); Modal.open('discover-modal'); };
        delegate($('share-dest-list'), [
            ['.share-dest', (row) => Actions.doShare({ kind: row.dataset.kind, id: row.dataset.id, name: row.dataset.name })]
        ]);

        // Guides
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
        $('btn-write-guide').onclick = () => Actions.ensureExperience(() => {
            $('guides-home').classList.add('hidden');
            $('guide-write').classList.remove('hidden');
        });
        $('btn-write-back').onclick = () => {
            $('guide-write').classList.add('hidden');
            $('guides-home').classList.remove('hidden');
        };
        $('btn-guide-submit').onclick = Actions.submitGuide;
        $('btn-guide-comment').onclick = Actions.submitGuideComment;
        $('guide-comment-input').onkeypress = e => { if (e.key === 'Enter') Actions.submitGuideComment(); };

        // Onboarding (buttons generated from config in Render.bootstrap).
        // Shown lazily via ensureExperience, never at startup — choosing or
        // skipping resolves quietly and continues whatever the user was doing.
        CFG.experiences.forEach(x => {
            $(`onboard-${x.id}`).onclick = () => Actions.resolveExperience(x.id);
        });
        $('onboard-skip').onclick = () => Actions.resolveExperience('regular');

        // Settings
        $('btn-settings').onclick = Actions.openSettings;
        $('user-name').onclick = Actions.openSettings;
        $('btn-settings-close').onclick = () => Modal.close('settings-modal');
        $('btn-save-name').onclick = () => {
            if (SkateChat.setDisplayName($('settings-name').value)) SkateChat.Notify.toast('Name updated ✓', 'success', 2000);
            else SkateChat.Notify.toast('That name won\'t work — try another', 'error', 2500);
        };
        delegate($('settings-timefmt'), [
            ['button[data-fmt]', (b) => { SkateSettings.set('timeFormat', b.dataset.fmt); Render.settings(); }]
        ]);
        delegate($('settings-exp'), [
            ['button[data-exp]', (b) => { Actions.applyExperience(b.dataset.exp); Render.settings(); }]
        ]);
        delegate($('settings-sections'), [
            ['button[data-vis]', (b) => {
                SkateSettings.set(b.dataset.vis, SkateSettings.get(b.dataset.vis) === false);
                Actions.applyVisibility();
                Render.settings();
            }]
        ]);
        $('btn-enable-notif').onclick = async () => {
            await SkateChat.Notify.requestPermission();
            Render.notif();
        };

        Modal.bindOverlays((id) => {
            if (id === 'invite-modal') { S.pendingInvite = null; Actions.clearHash(); }
            if (id === 'myrinks-modal') Actions.closeMyRinks();
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
                    if (modal.id === 'onboarding-modal') S.pendingExpAction = null; // ask again next time
                    if (modal.id === 'myrinks-modal') Actions.closeMyRinks();
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

        // Rink map + service alerts load in parallel with programs;
        // whichever lands last re-renders so badges/distances appear.
        SkateGeo.load();
        SkateAlerts.load();
        SkateGeo.onUpdate(() => { if (S.programs.length) Actions.applyFilters(true); });
        SkateAlerts.onUpdate(() => { if (S.programs.length) Render.programs(); });
        SkateLive.onUpdate(() => { if (S.programs.length) Render.programs(); });

        try {
            const programs = await SkateAPI.getSkatingPrograms();
            S.programs = programs || [];
            Render.typeChips();           // prune categories absent from this dataset
            Render.scopeChips();          // "(N)" active-location count
            Actions.applyFilters();
            SkateLive.load(S.programs);   // live venue spots (TTL-throttled)
            if (S.pendingProgramFocus) { Actions.focusProgram(S.pendingProgramFocus); S.pendingProgramFocus = null; }
        } catch (e) {
            $('program-list').innerHTML = '<li class="loading">Could not load programs 😕 — pull to refresh or try again later.</li>';
        }

        // Keep "Starts in Xm / On now · Xm left" honest and let just-ended
        // sessions drop off — re-filter once a minute, preserving the page.
        // Same tick refreshes live venue spots (SkateLive self-throttles).
        setInterval(() => {
            if (S.programs.length && document.visibilityState !== 'hidden') {
                Actions.applyFilters(true);
                SkateLive.load(S.programs);
            }
        }, 60000);

        // Community stack (chat + guides + relays) boots only when a
        // community section is visible; deep links await it via route paths.
        if (communityWanted()) await Actions.bootCommunity();
        SkateSettings.onChange(() => { Render.programs(); if (chatBooted) Render.chatUI(SkateChat.getState()); });

        Actions.route();
        window.addEventListener('hashchange', Actions.route);
    }

    return { init, S, Render, Actions };
})();

SkateApp.init();
