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
        darkMode: localStorage.getItem('darkMode') === 'true',
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

        ageBadge(p) {
            const min = p['Age Min'], max = p['Age Max'];
            if (min && max) return `<span class="age-badge">Ages ${min}-${max}</span>`;
            if (min) return `<span class="age-badge">Ages ${min}+</span>`;
            if (max) return `<span class="age-badge">Under ${max}</span>`;
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
        // View tabs
        const tabs = $('view-tabs');
        tabs.innerHTML = '';
        CFG.views.forEach((v, i) => {
            const btn = el('button', { class: 'view-tab' + (i === 0 ? ' active' : ''), dataset: { view: v.id } }, [v.label + (v.badgeId ? ' ' : '')]);
            if (v.badgeId) btn.appendChild(el('span', { class: 'badge hidden', id: v.badgeId }, ['0']));
            tabs.appendChild(btn);
        });
        tabs.onclick = e => {
            const t = e.target.closest('.view-tab');
            if (t) Actions.switchView(t.dataset.view);
        };

        // Program type chips
        chips($('type-filters'), CFG.programTypes, {
            attr: 'type', active: 'all',
            onPick: id => { S.type = id; Actions.applyFilters(); }
        });

        // Day options
        fillSelect($('day-filter'), CFG.days);

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
        seg($('settings-exp'), CFG.experiences, 'exp');

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

    /* ---------- Programs ---------- */
    Render.programs = function () {
        const { filtered, page, perPage } = S;
        const start = (page - 1) * perPage;
        const items = filtered.slice(start, start + perPage);
        const chatState = SkateChat.getState();
        const now = new Date();

        $('stats-text').textContent = `${filtered.length} programs found`;
        const metadata = SkateAPI.getMetadata();
        if (metadata?.lastUpdated) {
            const updated = new Date(metadata.lastUpdated);
            const daysAgo = Math.floor((now - updated) / 86400000);
            const dateStr = updated.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
            $('data-updated').textContent = daysAgo === 0 ? 'Updated today' : daysAgo === 1 ? 'Updated yesterday' : `Updated ${dateStr}`;
            $('data-updated').classList.toggle('stale', daysAgo > 7);
        }

        if (!filtered.length) {
            $('program-list').innerHTML = `<li class="loading">${S.type === 'favorites' ? 'No saved programs yet. Tap ❤️ on any program to save it!' : 'No matching programs found'}</li>`;
            Render.pagination(0);
            return;
        }

        $('program-list').innerHTML = items.map((p, i) => Render.programRow(p, start + i, chatState, now)).join('');
        Render.pagination(Math.ceil(filtered.length / perPage));
    };

    Render.programRow = function (p, idx, chatState, now) {
        const pid = P.id(p);
        const activity = P.activity(p) || 'Unknown';
        const location = P.location(p);
        const time = P.time(p), endTime = P.endTime(p);

        let dateDisplay = '', programDate = null;
        if (P.dateStr(p)) {
            programDate = parseLocalDate(P.dateStr(p));
            dateDisplay = programDate.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
        }
        let happeningSoon = false;
        if (programDate && time) {
            const [h, m] = time.split(':').map(Number);
            const eventTime = new Date(programDate); eventTime.setHours(h || 0, m || 0, 0, 0);
            const diff = eventTime - now;
            happeningSoon = diff > 0 && diff < 2 * 3600000;
        }

        // Action buttons from config (order + gating are data)
        const votes = SkateChat.getVotes(p);
        const isFavorite = SkateChat.Favorites.has(p);
        const actionHtml = CFG.programActions.map(a => {
            if (a.gated === 'activeGroup' && !chatState.activeGroup) return '';
            let title = a.title || '', text = a.text || '', extraCls = '';
            if (a.act === 'fav') {
                title = isFavorite ? 'Remove from saved' : 'Save this program';
                text = isFavorite ? '❤️' : '🤍';
                extraCls = isFavorite ? ' active' : '';
            } else if (a.act === 'vote') {
                title = `Vote for this time with ${escapeHtml(chatState.activeGroup.name)}`;
                text = `👍 ${votes.count || ''}`;
                extraCls = votes.mine ? ' voted' : '';
            }
            return `<button data-act="${a.act}" data-idx="${idx}" class="${a.cls}${extraCls}" title="${title}">${text}</button>`;
        }).join('');

        const locationHtml = location ? `<a href="${mapsUrl(location)}" target="_blank" rel="noopener" class="program-location">📍 ${escapeHtml(location)} ↗</a>` : '';

        return `
            <li class="program-item ${happeningSoon ? 'happening-soon' : ''}" data-pid="${pid}">
                <div class="program-header">
                    <div>
                        <div class="program-title">${escapeHtml(activity)}</div>
                        ${locationHtml}
                    </div>
                    <div class="program-meta">
                        ${happeningSoon ? '<span class="happening-now">Starting Soon</span>' : ''}
                        <div class="program-date">${dateDisplay}</div>
                        <div>${fmtClock(time)}${endTime ? '–' + fmtClock(endTime) : ''}</div>
                    </div>
                </div>
                <div class="program-footer">
                    <div class="program-badges">${P.tagFor(p)} ${P.ageBadge(p)}</div>
                    <div class="program-actions">${actionHtml}</div>
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

    Render.members = function (groupId) {
        const roster = SkateChat.getRoster(groupId);
        $('members-bar').classList.remove('hidden');
        const ml = $('members-list');
        ml.innerHTML = '';
        if (!roster.length) {
            ml.appendChild(el('span', { class: 'members-solo' }, ['Just you so far — messages wait here for whoever joins']));
            return;
        }
        roster.slice(0, 8).forEach(r => {
            const chip = el('button', {
                class: 'member-chip' + (r.muted ? ' is-muted' : ''),
                dataset: { pk: r.pubkey, name: r.name },
                title: `${r.name} — message or mute`
            });
            chip.innerHTML = `${hueDot(r.pubkey)}${r.online ? '<span class="online-dot"></span>' : ''}${escapeHtml(r.name)}${r.muted ? ' 🔇' : ''}`;
            ml.appendChild(chip);
        });
        if (roster.length > 8) ml.appendChild(el('span', { class: 'members-more' }, [`+${roster.length - 8}`]));
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
        $$('#settings-timefmt button').forEach(b => b.classList.toggle('active', b.dataset.fmt === fmt));
        $$('#settings-exp button').forEach(b => b.classList.toggle('active', b.dataset.exp === exp));
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
            return [
                { ...A('copyDetails'), onClick: () => copyText(programText(p)) },
                { ...A('copyLink'), onClick: () => copyText(`${baseUrl()}#p=${P.id(p)}`, 'Link copied! 🔗') },
                { ...A('addCalendar'), onClick: () => downloadIcs(p) }
            ];
        }
    };

    /* ================= Actions (named intents) ================= */
    const Actions = {};

    Actions.switchView = view => Render.switchView(view);

    Actions.applyFilters = function () {
        let result = S.programs.filter(p => P.matchesType(p, S.type));
        if (S.search) {
            const term = S.search.toLowerCase();
            result = result.filter(p => P.activity(p).toLowerCase().includes(term) || P.location(p).toLowerCase().includes(term));
        }
        if (S.day) result = result.filter(p => p['Day of Week'] === S.day);
        if (S.age !== null) result = result.filter(p => S.age >= (p['Age Min'] || 0) && S.age <= (p['Age Max'] || 999));

        const now = new Date(); now.setHours(0, 0, 0, 0);
        if (!S.showPast) result = result.filter(p => !P.dateStr(p) || parseLocalDate(P.dateStr(p)) >= now);

        result.sort((a, b) => parseLocalDate(P.dateStr(a) || '9999') - parseLocalDate(P.dateStr(b) || '9999'));
        S.filtered = result;
        S.page = 1;
        Render.programs();
    };

    Actions.focusProgram = function (pid) {
        const find = () => S.filtered.findIndex(p => P.id(p) === pid);
        let idx = find();
        if (idx === -1) {
            // widen the net: clear filters, include past events
            S.type = 'all'; S.search = ''; S.day = ''; S.age = null; S.showPast = true;
            $('search-input').value = ''; $('day-filter').value = ''; $('age-filter').value = '';
            $('show-past-toggle').checked = true;
            $$('#type-filters .filter-chip').forEach(c => c.classList.toggle('active', c.dataset.type === 'all'));
            Actions.applyFilters();
            idx = find();
        }
        if (idx === -1) return SkateChat.Notify.toast('That program isn\'t in the current dataset anymore', 'error');
        S.page = Math.floor(idx / S.perPage) + 1;
        Render.programs();
        requestAnimationFrame(() => flash(document.querySelector(`.program-item[data-pid="${pid}"]`)));
    };

    Actions.openGuide = function (id) {
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
            await SkateChat.acceptInvite(inv, $('invite-pw-input').value || null);
            S.pendingInvite = null;
            Modal.close('invite-modal');
            Actions.clearHash();
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

    Actions.applyDarkMode = function () {
        document.body.classList.toggle('dark-mode', S.darkMode);
        $('btn-dark-mode').textContent = S.darkMode ? '☀️' : '🌙';
    };

    Actions.refreshPrograms = async function () {
        $('btn-refresh').disabled = true; $('btn-refresh').textContent = '⏳';
        try {
            SkateAPI._skatingPrograms = null;
            S.programs = (await SkateAPI.getSkatingPrograms()) || [];
            Actions.applyFilters();
            SkateChat.Notify.toast('Programs reloaded!', 'success', 2000);
            await SkateRefresh.requestCityRefresh();
        } catch (e) { SkateChat.Notify.toast('Refresh failed: ' + e.message, 'error'); }
        finally { $('btn-refresh').disabled = false; $('btn-refresh').textContent = '🔄'; }
    };

    /* ================= Bindings ================= */
    function bind() {
        // Programs
        $('btn-search').onclick = () => { S.search = $('search-input').value.trim(); Actions.applyFilters(); };
        $('search-input').onkeypress = e => { if (e.key === 'Enter') { S.search = $('search-input').value.trim(); Actions.applyFilters(); } };
        $('btn-refresh').onclick = Actions.refreshPrograms;
        $('day-filter').onchange = () => { S.day = $('day-filter').value; Actions.applyFilters(); };
        $('age-filter').onchange = () => { S.age = $('age-filter').value ? parseInt($('age-filter').value) : null; Actions.applyFilters(); };
        $('show-past-toggle').onchange = () => { S.showPast = $('show-past-toggle').checked; Actions.applyFilters(); };

        // Single button — the old <label>-wrapped version double-fired.
        $('btn-dark-mode').onclick = () => {
            S.darkMode = !S.darkMode;
            Actions.applyDarkMode();
            localStorage.setItem('darkMode', S.darkMode);
        };

        const goPage = (hit) => {
            if (hit.dataset.p) { S.page = parseInt(hit.dataset.p); Render.programs(); $('programs-panel').scrollTop = 0; }
        };
        delegate($('pagination'), [['button[data-p]', goPage]]);
        delegate($('pagination-top'), [['button[data-p]', goPage]]);

        delegate($('program-list'), [
            ['button[data-act]', (btn) => {
                const p = S.filtered[parseInt(btn.dataset.idx)];
                if (!p) return;
                const act = btn.dataset.act;
                if (act === 'fav') { SkateChat.Favorites.toggle(p); Render.programs(); }
                else if (act === 'vote') SkateChat.voteTime(p);
                else if (act === 'share') Actions.openSharePicker({ type: 'program', payload: p });
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
        $('btn-write-guide').onclick = () => {
            $('guides-home').classList.add('hidden');
            $('guide-write').classList.remove('hidden');
        };
        $('btn-write-back').onclick = () => {
            $('guide-write').classList.add('hidden');
            $('guides-home').classList.remove('hidden');
        };
        $('btn-guide-submit').onclick = Actions.submitGuide;
        $('btn-guide-comment').onclick = Actions.submitGuideComment;
        $('guide-comment-input').onkeypress = e => { if (e.key === 'Enter') Actions.submitGuideComment(); };

        // Onboarding (buttons generated from config in Render.bootstrap)
        CFG.experiences.forEach(x => {
            $(`onboard-${x.id}`).onclick = () => { Modal.close('onboarding-modal'); Actions.applyExperience(x.id); };
        });

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
        $('btn-enable-notif').onclick = async () => {
            await SkateChat.Notify.requestPermission();
            Render.notif();
        };

        Modal.bindOverlays((id) => {
            if (id === 'invite-modal') { S.pendingInvite = null; Actions.clearHash(); }
        });

        // Keyboard: 1-N switch views, Esc walks back (popover → modal → conversation)
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                if (Popover.isOpen()) return Popover.close();
                const modal = Modal.any();
                if (modal && modal.id !== 'onboarding-modal') {
                    modal.classList.add('hidden');
                    if (modal.id === 'invite-modal') { S.pendingInvite = null; Actions.clearHash(); }
                    return;
                }
                if (S.chatOpen && $('chats-panel').classList.contains('active')) return Actions.backToList();
                return;
            }
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
            const n = parseInt(e.key);
            if (n >= 1 && n <= CFG.views.length) Actions.switchView(CFG.views[n - 1].id);
        });
    }

    /* ================= Boot ================= */
    async function init() {
        Render.bootstrap();
        Actions.applyDarkMode();
        bind();

        if (!SkateSettings.get('experience')) {
            Modal.open('onboarding-modal');
        } else if (SkateSettings.get('experience') === 'new' && !sessionStorage.getItem('skate_seen_this_session')) {
            Actions.switchView('guides');
        }
        sessionStorage.setItem('skate_seen_this_session', '1');

        try {
            const programs = await SkateAPI.getSkatingPrograms();
            S.programs = programs || [];
            Actions.applyFilters();
            if (S.pendingProgramFocus) { Actions.focusProgram(S.pendingProgramFocus); S.pendingProgramFocus = null; }
        } catch (e) {
            $('program-list').innerHTML = '<li class="loading">Could not load programs 😕 — pull to refresh or try again later.</li>';
        }

        await SkateChat.init();
        SkateChat.onUpdate(Render.chatUI);
        SkateGuides.load();
        SkateGuides.onUpdate(scheduleGuidesRender);
        SkateSettings.onChange(() => { Render.programs(); Render.chatUI(SkateChat.getState()); });

        Actions.route();
        window.addEventListener('hashchange', Actions.route);
    }

    return { init, S, Render, Actions };
})();

SkateApp.init();
