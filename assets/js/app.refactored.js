// ============================================
// NOSTR ORBIT — Refactored App
// ============================================

(function() {
    'use strict';

    // ============================================
    // CONFIGURATION
    // ============================================
    const CONFIG = {
        RELAY_TIMEOUT_MS: 30000,        // How long to keep relay connections open
        DEBOUNCE_RENDER_MS: 150,        // Debounce delay for rendering updates
        EVENT_FETCH_LIMIT: 500,         // Max events to fetch per request
        MAX_TIME_RANGE_HOURS: 720,      // Max 30 days
        MAX_IMPORT_FOLLOWS: 50,         // Max follows to import at once
        TOAST_DURATION_MS: 3000,        // How long toasts show
        PLAYBACK_BASE_INTERVAL_MS: 300, // Base interval for playback animation
    };

    // ============================================
    // STATE
    // ============================================
    const S = {
        users: [],
        selectedUser: null,
        userEvents: [],
        viewMode: 'all',
        selectedEvent: null,
        timeRangeHours: 24,
        seenEventIds: new Set(),
        showThreadLines: false,
        eventPositions: new Map(),
        parentEvents: new Map(),
        isPlaying: false,
        playbackIndex: 0,
        playbackSpeed: 1,
        playbackInterval: null,
        sortedEventsForPlayback: [],
        currentIdentity: null,
        compareMode: false,
        compareUser: null,
        compareEvents: [],
        compareCanvas: null,
        compareCtx: null,
        compareEventPositions: new Map(),
        currentRequestId: 0,
        isLoading: false
    };

    const DEFAULT_RELAYS = [
        'wss://relay.damus.io',
        'wss://nos.lol', 
        'wss://relay.snort.social',
        'wss://relay.primal.net',
        'wss://nostr.wine'
    ];

    const DEFAULT_USERS = [
        'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m',
        'npub1a2cww4kn9wqte4ry70vyfwqyqvpswksna27rtxd8vty6c74era8sdcw83a',
        'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
        'npub1gcxzte5zlkncx26j68ez60fzkvtkm9e0vrwdcvsjakxf9mu9qewqlfnj5z',
        'npub1qny3tkh0acurzla8x3zy4nhrjz5zd8l9sy9jys09umwng00manysew95gx',
    ];

    let relays = [];
    const activeConnections = new Map();

    // ============================================
    // UTILITIES
    // ============================================
    const $ = id => document.getElementById(id);
    const $$ = sel => document.querySelectorAll(sel);

    function formatTime(ts) {
        const diff = Date.now() - ts * 1000;
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function showToast(msg) {
        const t = $('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), CONFIG.TOAST_DURATION_MS);
    }

    function npubToHex(npub) {
        try {
            if (npub.startsWith('npub1')) return NostrTools.nip19.decode(npub).data;
            if (/^[0-9a-fA-F]{64}$/.test(npub)) return npub.toLowerCase();
        } catch (e) {}
        return null;
    }

    function hexToNpub(hex) {
        try { return NostrTools.nip19.npubEncode(hex); } 
        catch (e) { return hex.slice(0, 8) + '...' + hex.slice(-4); }
    }

    // ============================================
    // RELAY MANAGEMENT
    // ============================================
    function loadStoredRelays() {
        const stored = localStorage.getItem('nostr_orbit_relays');
        if (stored) {
            try { 
                const parsed = JSON.parse(stored);
                // Ensure status is always initialized
                relays = parsed.map(r => ({ 
                    url: r.url, 
                    enabled: r.enabled !== false, 
                    status: 'closed' // Always start as closed, will update when connecting
                }));
                return; 
            } catch (e) {}
        }
        relays = DEFAULT_RELAYS.map(url => ({ url, enabled: true, status: 'closed' }));
        saveRelays();
    }

    function saveRelays() {
        localStorage.setItem('nostr_orbit_relays', JSON.stringify(relays.map(r => ({ url: r.url, enabled: r.enabled }))));
    }

    function toggleRelayManager() {
        $('relay-manager').classList.toggle('show');
    }

    function renderRelayList() {
        $('relay-list').innerHTML = relays.map((r, i) => `
            <div class="relay-item">
                <div class="relay-dot ${r.status}"></div>
                <span class="relay-url" title="${r.url}">${r.url.replace('wss://', '')}</span>
                <button class="relay-toggle ${r.enabled ? 'active' : ''}" onclick="toggleRelay(${i})">${r.enabled ? 'ON' : 'OFF'}</button>
            </div>
        `).join('');
    }

    function renderRelayBar() {
        $('relay-bar').innerHTML = relays.filter(r => r.enabled).map(r => `
            <div class="relay-chip" title="${r.url}">
                <div class="relay-dot ${r.status}"></div>
                ${r.url.replace('wss://', '').split('/')[0].slice(0, 15)}
            </div>
        `).join('');
    }

    function updateRelayCount() {
        $('relay-count').textContent = `${relays.filter(r => r.status === 'connected').length}/${relays.filter(r => r.enabled).length}`;
    }

    function toggleRelay(i) {
        relays[i].enabled = !relays[i].enabled;
        if (!relays[i].enabled) {
            relays[i].status = 'closed';
            const sock = activeConnections.get(relays[i].url);
            if (sock) { sock.close(); activeConnections.delete(relays[i].url); }
        }
        saveRelays();
        renderRelayList();
        renderRelayBar();
        updateRelayCount();
    }

    function addCustomRelay() {
        let url = $('new-relay-input').value.trim();
        if (!url) return;
        if (!url.startsWith('wss://') && !url.startsWith('ws://')) url = 'wss://' + url;
        if (relays.find(r => r.url === url)) { showToast('Relay already added'); return; }
        relays.push({ url, enabled: true, status: 'closed' });
        saveRelays();
        renderRelayList();
        renderRelayBar();
        updateRelayCount();
        $('new-relay-input').value = '';
        showToast('Relay added!');
    }

    function closeAllConnections() {
        activeConnections.forEach(sock => {
            if (sock.readyState <= 1) sock.close();
        });
        activeConnections.clear();
        relays.forEach(r => r.status = 'closed');
        renderRelayBar();
        updateRelayCount();
    }

    function connectToRelays(subId, filter, onEvent, onEose) {
        const enabled = relays.filter(r => r.enabled);
        let eoseCount = 0;
        enabled.forEach(relay => {
            connectToRelay(relay.url, subId, filter, onEvent, () => {
                if (++eoseCount >= enabled.length && onEose) onEose();
            });
        });
    }

    function connectToRelay(url, subId, filter, onEvent, onEose) {
        const relay = relays.find(r => r.url === url);
        
        // Close any existing connection to this relay before creating new one
        const existingSock = activeConnections.get(url);
        if (existingSock && existingSock.readyState <= WebSocket.OPEN) {
            existingSock.close();
            activeConnections.delete(url);
        }
        
        if (relay) { relay.status = 'connecting'; renderRelayBar(); renderRelayList(); updateRelayCount(); }

        try {
            const sock = new WebSocket(url);
            activeConnections.set(url, sock);

            sock.onopen = () => {
                if (relay) { relay.status = 'connected'; renderRelayBar(); renderRelayList(); updateRelayCount(); }
                sock.send(JSON.stringify(['REQ', subId, filter]));
            };

            sock.onmessage = msg => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data[0] === 'EVENT' && data[2]) onEvent(data[2]);
                    else if (data[0] === 'EOSE' && onEose) onEose();
                } catch (e) {}
            };

            sock.onerror = () => {
                if (relay) { relay.status = 'error'; renderRelayBar(); renderRelayList(); updateRelayCount(); }
            };

            sock.onclose = () => {
                // Only mark as closed if it wasn't an error
                if (relay && relay.status !== 'error') { 
                    relay.status = 'closed'; 
                }
                activeConnections.delete(url);
                renderRelayBar(); 
                renderRelayList(); 
                updateRelayCount();
            };

            // Auto-close after timeout to free resources
            setTimeout(() => { 
                if (sock.readyState === WebSocket.OPEN) {
                    sock.close();
                }
            }, CONFIG.RELAY_TIMEOUT_MS);
        } catch (e) {
            if (relay) { relay.status = 'error'; renderRelayBar(); renderRelayList(); updateRelayCount(); }
        }
    }

    // ============================================
    // USER MANAGEMENT
    // ============================================
    function loadStoredUsers() {
        const stored = localStorage.getItem('nostr_orbit_users');
        if (stored) try { S.users = JSON.parse(stored); } catch (e) { S.users = []; }
    }

    function saveUsers() {
        localStorage.setItem('nostr_orbit_users', JSON.stringify(S.users));
    }

    function loadDefaultUsers() {
        DEFAULT_USERS.forEach(npub => {
            const pubkey = npubToHex(npub);
            if (pubkey) S.users.push({ pubkey, npub, name: null, picture: null, about: null, lastActivity: null, postCount: 0 });
        });
        saveUsers();
        fetchAllProfiles();
    }

    function addUserFromInput() {
        const val = $('npub-input').value.trim();
        if (!val) return;
        const pubkey = npubToHex(val);
        if (!pubkey) { showToast('Invalid npub or pubkey'); return; }
        if (S.users.find(u => u.pubkey === pubkey)) { showToast('User already added'); return; }
        S.users.push({ pubkey, npub: hexToNpub(pubkey), name: null, picture: null, about: null, lastActivity: null, postCount: 0 });
        saveUsers();
        renderUserList();
        fetchProfile(pubkey);
        $('npub-input').value = '';
        showToast('User added!');
    }

    function removeUser(pubkey, e) {
        e.stopPropagation();
        S.users = S.users.filter(u => u.pubkey !== pubkey);
        saveUsers();
        if (S.selectedUser?.pubkey === pubkey) { S.selectedUser = null; clearTimeline(); }
        renderUserList();
    }

    function sortUsers(type) {
        $$('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === type));
        if (type === 'recent') S.users.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
        else if (type === 'posts') S.users.sort((a, b) => (b.postCount || 0) - (a.postCount || 0));
        else S.users.sort((a, b) => (a.name || a.npub).localeCompare(b.name || b.npub));
        renderUserList();
    }

    function renderUserList() {
        const c = $('user-list');
        if (!S.users.length) {
            c.innerHTML = '<div class="empty-state"><div class="icon">👥</div><p>Add Nostr users to track their activity</p></div>';
            return;
        }
        c.innerHTML = S.users.map(u => `
            <div class="user-card ${S.selectedUser?.pubkey === u.pubkey ? 'selected' : ''}" onclick="selectUser('${u.pubkey}')">
                <div class="user-avatar">${u.picture ? `<img src="${u.picture}" onerror="this.parentElement.innerHTML='👤'">` : '👤'}</div>
                <div class="user-info">
                    <div class="user-name">${u.name || 'Loading...'}</div>
                    <div class="user-npub">${u.npub.slice(0, 12)}...${u.npub.slice(-4)}</div>
                    <div class="user-stats">${u.postCount || 0} posts in ${formatRangeLabel(S.timeRangeHours)}</div>
                </div>
                ${S.compareMode ? `<button class="user-compare-btn ${S.compareUser?.pubkey === u.pubkey ? 'active' : ''}" onclick="selectCompareUser('${u.pubkey}', event)" title="Compare">${S.compareUser?.pubkey === u.pubkey ? '📊' : '⚖️'}</button>` : ''}
                <button class="user-remove" onclick="removeUser('${u.pubkey}', event)">×</button>
            </div>
        `).join('');
    }

    function fetchAllProfiles() {
        connectToRelays('profiles', { kinds: [0], authors: S.users.map(u => u.pubkey) }, handleProfile);
    }

    function fetchProfile(pubkey) {
        connectToRelays('profile-' + pubkey.slice(0, 8), { kinds: [0], authors: [pubkey] }, handleProfile);
    }

    function handleProfile(event) {
        if (event.kind !== 0) return;
        try {
            const p = JSON.parse(event.content);
            const user = S.users.find(u => u.pubkey === event.pubkey);
            if (user) {
                user.name = p.name || p.display_name || p.displayName;
                user.picture = p.picture;
                user.about = p.about;
                saveUsers();
                renderUserList();
            }
        } catch (e) {}
    }

    // ============================================
    // USER SELECTION & EVENTS
    // ============================================
    function selectUser(pubkey) {
        const user = S.users.find(u => u.pubkey === pubkey);
        if (!user) return;
        S.selectedUser = user;
        renderUserList();
        $('selected-user-info').textContent = `Loading ${user.name || 'user'}'s activity...`;
        fetchUserEvents(pubkey);
    }

    function fetchUserEvents(pubkey) {
        const reqId = ++S.currentRequestId;
        S.isLoading = true;
        S.userEvents = [];
        S.seenEventIds.clear();
        S.parentEvents.clear();
        clearTimeline();

        const now = Math.floor(Date.now() / 1000);
        const since = now - S.timeRangeHours * 3600;
        $('selected-user-info').innerHTML = '<span class="spinner" style="display:inline-block;width:12px;height:12px;border-width:2px;margin-right:8px;"></span>Loading...';

        connectToRelays('user-events-' + reqId, { kinds: [1], authors: [pubkey], since, until: now, limit: CONFIG.EVENT_FETCH_LIMIT }, event => {
            if (reqId !== S.currentRequestId || event.pubkey !== pubkey || S.seenEventIds.has(event.id)) return;
            S.seenEventIds.add(event.id);

            const eTags = event.tags.filter(t => t[0] === 'e');
            const isReply = eTags.length > 0;
            const parentEventId = isReply ? (eTags.find(t => t[3] === 'reply')?.[1] || eTags[eTags.length - 1]?.[1]) : null;
            if (parentEventId) S.parentEvents.set(event.id, parentEventId);

            S.userEvents.push({ id: event.id, content: event.content, created_at: event.created_at, isReply, parentEventId, tags: event.tags });

            const user = S.users.find(u => u.pubkey === pubkey);
            if (user) { user.postCount = S.userEvents.length; user.lastActivity = Math.max(user.lastActivity || 0, event.created_at); }

            clearTimeout(window._rt);
            window._rt = setTimeout(() => {
                if (reqId !== S.currentRequestId) return;
                saveUsers();
                renderTimeline();
                updateStats();
                renderEventFeed();
                renderUserList();
            }, CONFIG.DEBOUNCE_RENDER_MS);
        }, () => {
            if (reqId !== S.currentRequestId) return;
            S.isLoading = false;
            $('selected-user-info').textContent = S.userEvents.length ? `${S.selectedUser?.name || 'User'} — ${S.userEvents.length} events in ${formatRangeLabel(S.timeRangeHours)}` : `${S.selectedUser?.name || 'User'} has no events in the last ${formatRangeLabel(S.timeRangeHours)}`;
            if (S.compareMode && S.compareUser) updateCompareStats();
        });
    }

    function setTimeRange(hours) {
        S.currentRequestId++;
        closeAllConnections();
        S.timeRangeHours = hours;
        $$('.time-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.hours) === hours));
        $('custom-time-input').value = '';
        // Update stats header
        const statsHeader = $('stats-header');
        if (statsHeader) statsHeader.textContent = `📈 ${formatRangeLabel(hours)} Stats`;
        // Redraw background even if no user selected
        const canvas = $('timeline-canvas');
        if (canvas) drawTimelineBackground(canvas.getContext('2d'), canvas.width, canvas.height);
        renderUserList(); // Update post counts display
        if (S.selectedUser) fetchUserEvents(S.selectedUser.pubkey);
        if (S.compareMode && S.compareUser) fetchCompareUserEvents(S.compareUser.pubkey);
    }

    function setCustomTimeRange(val) {
        const hours = parseInt(val);
        if (isNaN(hours) || hours < 1) { showToast('⚠️ Enter valid hours'); return; }
        if (hours > CONFIG.MAX_TIME_RANGE_HOURS) { showToast(`⚠️ Max ${CONFIG.MAX_TIME_RANGE_HOURS / 24} days`); return; }
        S.currentRequestId++;
        closeAllConnections();
        S.timeRangeHours = hours;
        $$('.time-btn').forEach(b => b.classList.remove('active'));
        // Update stats header
        const statsHeader = $('stats-header');
        if (statsHeader) statsHeader.textContent = `📈 ${formatRangeLabel(hours)} Stats`;
        // Redraw background even if no user selected  
        const canvas = $('timeline-canvas');
        if (canvas) drawTimelineBackground(canvas.getContext('2d'), canvas.width, canvas.height);
        renderUserList(); // Update post counts display
        if (S.selectedUser) fetchUserEvents(S.selectedUser.pubkey);
        if (S.compareMode && S.compareUser) fetchCompareUserEvents(S.compareUser.pubkey);
        showToast(`⏱️ Showing last ${formatRangeLabel(hours)}`);
    }

    function setViewMode(mode) {
        S.viewMode = mode;
        $$('.toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
        if (S.selectedUser) { renderTimeline(); updateStats(); renderEventFeed(); }
        if (S.compareMode && S.compareUser) renderCompareTimeline();
    }

    // ============================================
    // TIMELINE VISUALIZATION
    // ============================================
    function setupCanvas() {
        const canvas = $('timeline-canvas');
        const ctx = canvas.getContext('2d');
        const resize = () => {
            const c = $('canvas-container');
            canvas.width = c.clientWidth;
            canvas.height = c.clientHeight;
            drawTimelineBackground(ctx, canvas.width, canvas.height);
        };
        resize();
        window.addEventListener('resize', resize);
    }

    function drawTimelineBackground(ctx, w, h) {
        ctx.clearRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.35;
        const hours = S.timeRangeHours;

        const g = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 1.2);
        g.addColorStop(0, 'rgba(99, 102, 241, 0.1)');
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = 'rgba(99, 102, 241, 0.3)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();

        // Dynamic tick marks and labels based on timeRangeHours
        const tickCount = getTickCount(hours);
        const labelInterval = getLabelInterval(hours);
        
        ctx.fillStyle = '#444';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let i = 0; i < tickCount; i++) {
            const angle = (i / tickCount) * Math.PI * 2 - Math.PI / 2;
            const isLabel = i % labelInterval === 0;
            ctx.strokeStyle = isLabel ? 'rgba(99, 102, 241, 0.5)' : 'rgba(99, 102, 241, 0.2)';
            ctx.lineWidth = isLabel ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(angle) * (r - 5), cy + Math.sin(angle) * (r - 5));
            ctx.lineTo(cx + Math.cos(angle) * (r + 5), cy + Math.sin(angle) * (r + 5));
            ctx.stroke();
            if (isLabel) {
                const hoursAgo = Math.round((tickCount - i) * (hours / tickCount));
                const label = formatTickLabel(hoursAgo, hours);
                ctx.fillText(label, cx + Math.cos(angle) * (r + 25), cy + Math.sin(angle) * (r + 25));
            }
        }

        // Draw direction arrow (clockwise = past → present)
        const arrowAngle = Math.PI * 0.75; // bottom-right
        const arrowR = r + 45;
        ctx.save();
        ctx.translate(cx + Math.cos(arrowAngle) * arrowR, cy + Math.sin(arrowAngle) * arrowR);
        ctx.rotate(arrowAngle + Math.PI / 2);
        ctx.fillStyle = 'rgba(99, 102, 241, 0.6)';
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.lineTo(5, 0);
        ctx.lineTo(0, 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Center info
        ctx.fillStyle = '#666';
        ctx.font = '11px monospace';
        ctx.fillText(formatRangeLabel(hours), cx, cy - 10);
        ctx.fillText('↻ PAST→NOW', cx, cy + 10);
    }

    // Helper: determine number of tick marks based on range
    function getTickCount(hours) {
        if (hours <= 6) return hours; // 1 tick per hour
        if (hours <= 12) return 12;
        if (hours <= 24) return 24;
        if (hours <= 48) return 24; // still 24 ticks for 2 days
        if (hours <= 168) return 28; // 7 days = 28 ticks (4 per day)
        return Math.min(Math.ceil(hours / 6), 48); // max 48 ticks
    }

    // Helper: how often to show labels
    function getLabelInterval(hours) {
        if (hours <= 6) return 1; // every tick
        if (hours <= 12) return 3; // every 3 ticks
        if (hours <= 24) return 6; // every 6 ticks
        if (hours <= 48) return 6;
        if (hours <= 168) return 7; // every 7 ticks (1 per day)
        return Math.max(Math.floor(getTickCount(hours) / 4), 1);
    }

    // Helper: format tick label based on time range
    function formatTickLabel(hoursAgo, totalHours) {
        if (hoursAgo === 0) return 'NOW';
        if (totalHours <= 24) return `-${hoursAgo}h`;
        if (totalHours <= 168) {
            const days = Math.round(hoursAgo / 24);
            return days === 0 ? 'NOW' : `-${days}d`;
        }
        const days = Math.round(hoursAgo / 24);
        return `-${days}d`;
    }

    // Helper: format center range label
    function formatRangeLabel(hours) {
        if (hours < 24) return `${hours}H`;
        if (hours % 24 === 0) return `${hours / 24}D`;
        return `${(hours / 24).toFixed(1)}D`;
    }

    function renderTimeline() {
        const container = $('canvas-container');
        const nodes = $('event-nodes');
        nodes.innerHTML = '';
        S.eventPositions.clear();
        clearSvgLines();

        const w = container.clientWidth, h = container.clientHeight;
        const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.35;

        const filtered = S.userEvents.filter(e => S.viewMode === 'all' || (S.viewMode === 'posts' ? !e.isReply : e.isReply));
        filtered.sort((a, b) => a.created_at - b.created_at);

        const now = Math.floor(Date.now() / 1000);
        const rangeStart = now - S.timeRangeHours * 3600;

        filtered.forEach(event => {
            const progress = (event.created_at - rangeStart) / (S.timeRangeHours * 3600);
            const angle = progress * Math.PI * 2 - Math.PI / 2;
            const hash = event.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
            const er = r + ((hash % 20) - 10);
            const x = cx + Math.cos(angle) * er;
            const y = cy + Math.sin(angle) * er;

            S.eventPositions.set(event.id, { x, y });

            // Check if this event has a visible thread connection
            const hasVisibleThread = event.parentEventId && filtered.some(e => e.id === event.parentEventId);

            const node = document.createElement('div');
            node.className = `event-node ${event.isReply ? 'reply' : 'post'}${hasVisibleThread ? ' has-thread' : ''}`;
            node.style.left = x + 'px';
            node.style.top = y + 'px';
            node.dataset.eventId = event.id;
            node.title = formatTime(event.created_at) + '\n' + event.content.slice(0, 100);
            node.onclick = () => selectEvent(event, false);
            node.onmouseenter = () => highlightThread(event);
            node.onmouseleave = clearThreadHighlight;
            nodes.appendChild(node);
        });

        if (S.showThreadLines) renderThreadLines(filtered);
        $('selected-user-info').textContent = `${S.selectedUser?.name || 'User'} — ${filtered.length} events in ${formatRangeLabel(S.timeRangeHours)}`;
        initPlayback();
    }

    function clearSvgLines() {
        const svg = $('connections-svg');
        if (svg) svg.querySelectorAll('path').forEach(p => p.remove());
    }

    function renderThreadLines(events) {
        const svg = $('connections-svg');
        if (!svg) return;
        clearSvgLines();
        const container = $('canvas-container');
        const cx = container.clientWidth / 2, cy = container.clientHeight / 2;

        events.forEach(e => {
            if (!e.parentEventId) return;
            const pPos = S.eventPositions.get(e.parentEventId);
            const cPos = S.eventPositions.get(e.id);
            if (!pPos || !cPos) return;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const midX = (pPos.x + cPos.x) / 2, midY = (pPos.y + cPos.y) / 2;
            path.setAttribute('d', `M ${pPos.x} ${pPos.y} Q ${midX + (cx - midX) * 0.2} ${midY + (cy - midY) * 0.2} ${cPos.x} ${cPos.y}`);
            path.setAttribute('class', 'connection-line thread');
            path.dataset.parentId = e.parentEventId;
            path.dataset.childId = e.id;
            svg.appendChild(path);
        });
    }

    function highlightThread(event) {
        if (!S.showThreadLines) return;
        const ids = new Set();
        let cur = event.id;
        while (cur) { ids.add(cur); cur = S.parentEvents.get(cur); }
        const findChildren = pid => S.userEvents.forEach(e => { if (e.parentEventId === pid && !ids.has(e.id)) { ids.add(e.id); findChildren(e.id); } });
        findChildren(event.id);

        $$('.connection-line').forEach(l => {
            if (ids.has(l.dataset.parentId) || ids.has(l.dataset.childId)) { l.classList.add('highlighted'); l.classList.remove('dimmed'); }
            else { l.classList.add('dimmed'); l.classList.remove('highlighted'); }
        });
        $$('.event-node').forEach(n => {
            if (ids.has(n.dataset.eventId)) { n.style.transform = 'translate(-50%, -50%) scale(1.3)'; n.style.zIndex = '50'; }
            else n.style.opacity = '0.4';
        });
    }

    function clearThreadHighlight() {
        $$('.connection-line').forEach(l => l.classList.remove('highlighted', 'dimmed'));
        $$('.event-node').forEach(n => { n.style.transform = ''; n.style.zIndex = ''; n.style.opacity = ''; });
    }

    function clearTimeline() {
        const canvas = $('timeline-canvas');
        drawTimelineBackground(canvas.getContext('2d'), canvas.width, canvas.height);
        $('event-nodes').innerHTML = '';
        clearSvgLines();
        S.eventPositions.clear();
        S.parentEvents.clear();
        const btn = $('thread-toggle');
        if (btn) btn.innerHTML = '🔗 Show Threads';
        stopPlayback();
        resetPlaybackUI();
        $('event-detail').innerHTML = '<h3 style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:12px;">📝 Event Feed</h3><div class="empty-state"><div class="icon">🔭</div><p>Select a user to view their events</p></div>';
    }

    function toggleThreadLines() {
        S.showThreadLines = !S.showThreadLines;
        const btn = $('thread-toggle');
        btn.classList.toggle('active', S.showThreadLines);
        
        // Count threads for both main and compare views
        const mainThreads = S.userEvents.filter(e => e.parentEventId && S.userEvents.some(p => p.id === e.parentEventId)).length;
        const compareThreads = S.compareMode ? S.compareEvents.filter(e => e.parentEventId && S.compareEvents.some(p => p.id === e.parentEventId)).length : 0;
        const threads = mainThreads + compareThreads;
        
        btn.innerHTML = S.showThreadLines ? `🔗 Hide (${threads})` : '🔗 Threads';
        if (S.showThreadLines && S.userEvents.length) { renderTimeline(); if (S.compareMode && S.compareEvents.length) renderCompareThreadLines(); }
        else { clearSvgLines(); clearCompareSvgLines(); }
    }

    // ============================================
    // PLAYBACK
    // ============================================
    function initPlayback() {
        let events = S.userEvents.filter(e => S.viewMode === 'all' || (S.viewMode === 'posts' ? !e.isReply : e.isReply)).map(e => ({ ...e, isCompareEvent: false }));
        if (S.compareMode && S.compareEvents.length) {
            events = [...events, ...S.compareEvents.filter(e => S.viewMode === 'all' || (S.viewMode === 'posts' ? !e.isReply : e.isReply)).map(e => ({ ...e, isCompareEvent: true }))];
        }
        S.sortedEventsForPlayback = events.sort((a, b) => a.created_at - b.created_at);
        S.playbackIndex = 0;
        updatePlaybackUI();
    }

    function togglePlayback() { S.isPlaying ? stopPlayback() : startPlayback(); }

    function startPlayback() {
        if (!S.sortedEventsForPlayback.length) initPlayback();
        if (!S.sortedEventsForPlayback.length) return;
        if (S.playbackIndex >= S.sortedEventsForPlayback.length) resetPlayback();
        if (S.playbackIndex === 0) $$('.event-node').forEach(n => { n.classList.add('hidden'); n.classList.remove('animated-in'); });

        S.isPlaying = true;
        $('play-btn').textContent = '⏸️';
        $('play-btn').classList.add('active');

        S.playbackInterval = setInterval(() => {
            if (S.playbackIndex < S.sortedEventsForPlayback.length) {
                showEventAtIndex(S.playbackIndex);
                S.playbackIndex++;
                updatePlaybackUI();
            } else stopPlayback();
        }, CONFIG.PLAYBACK_BASE_INTERVAL_MS / S.playbackSpeed);
    }

    function showEventAtIndex(index) {
        const event = S.sortedEventsForPlayback[index];
        if (!event) return;
        
        const containerId = event.isCompareEvent ? 'compare-nodes' : 'event-nodes';
        const node = document.querySelector(`#${containerId} .event-node[data-event-id="${event.id}"]`);
        if (node) {
            node.classList.remove('hidden');
            node.classList.add('animated-in');
            
            // Draw thread line if applicable and threads are enabled
            if (S.showThreadLines && event.parentEventId) {
                const positions = event.isCompareEvent ? S.compareEventPositions : S.eventPositions;
                const parentPos = positions.get(event.parentEventId);
                const childPos = positions.get(event.id);
                
                if (parentPos && childPos) {
                    drawSingleThreadLine(event, parentPos, childPos, event.isCompareEvent);
                }
            }
        }
    }

    function drawSingleThreadLine(event, parentPos, childPos, isCompare = false) {
        const svgId = isCompare ? 'compare-connections-svg' : 'connections-svg';
        const containerId = isCompare ? 'compare-container' : 'canvas-container';
        const svg = $(svgId);
        if (!svg) return;
        
        const container = $(containerId);
        const cx = container.clientWidth / 2;
        const cy = container.clientHeight / 2;
        
        const midX = (parentPos.x + childPos.x) / 2;
        const midY = (parentPos.y + childPos.y) / 2;
        const ctrlX = midX + (cx - midX) * 0.2;
        const ctrlY = midY + (cy - midY) * 0.2;
        
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${parentPos.x} ${parentPos.y} Q ${ctrlX} ${ctrlY} ${childPos.x} ${childPos.y}`);
        path.setAttribute('class', 'connection-line thread');
        path.style.opacity = '0';
        path.style.transition = 'opacity 0.3s';
        path.dataset.parentId = event.parentEventId;
        path.dataset.childId = event.id;
        
        svg.appendChild(path);
        
        // Animate in
        requestAnimationFrame(() => { path.style.opacity = '0.6'; });
    }

    function stopPlayback() {
        S.isPlaying = false;
        if (S.playbackInterval) { clearInterval(S.playbackInterval); S.playbackInterval = null; }
        $('play-btn').textContent = '▶️';
        $('play-btn').classList.remove('active');
    }

    function resetPlayback() {
        stopPlayback();
        S.playbackIndex = 0;
        $$('.event-node').forEach(n => n.classList.remove('hidden', 'animated-in'));
        updatePlaybackUI();
    }

    function seekPlayback(e) {
        const bar = $('playback-progress');
        const pct = (e.clientX - bar.getBoundingClientRect().left) / bar.offsetWidth;
        const wasPlaying = S.isPlaying;
        stopPlayback();
        S.playbackIndex = Math.max(0, Math.min(Math.floor(pct * S.sortedEventsForPlayback.length), S.sortedEventsForPlayback.length));
        
        $$('.event-node').forEach(n => {
            const idx = S.sortedEventsForPlayback.findIndex(ev => ev.id === n.dataset.eventId);
            if (idx >= 0 && idx < S.playbackIndex) n.classList.remove('hidden', 'animated-in');
            else if (idx >= S.playbackIndex) { n.classList.add('hidden'); n.classList.remove('animated-in'); }
        });
        
        // Redraw thread lines for visible events if enabled
        if (S.showThreadLines) {
            clearSvgLines();
            clearCompareSvgLines();
            const visibleEvents = S.sortedEventsForPlayback.slice(0, S.playbackIndex);
            const mainVisible = visibleEvents.filter(e => !e.isCompareEvent);
            const compareVisible = visibleEvents.filter(e => e.isCompareEvent);
            if (mainVisible.length) renderThreadLines(mainVisible);
            if (compareVisible.length) renderCompareThreadLines();
        }
        
        updatePlaybackUI();
        if (wasPlaying) startPlayback();
    }

    function cycleSpeed() {
        const speeds = [1, 2, 4, 8];
        S.playbackSpeed = speeds[(speeds.indexOf(S.playbackSpeed) + 1) % speeds.length];
        $('playback-speed').textContent = `${S.playbackSpeed}x`;
        if (S.isPlaying) { stopPlayback(); startPlayback(); }
    }

    function updatePlaybackUI() {
        $('playback-time').textContent = `${S.playbackIndex} / ${S.sortedEventsForPlayback.length}`;
        $('playback-progress-bar').style.width = `${S.sortedEventsForPlayback.length ? (S.playbackIndex / S.sortedEventsForPlayback.length) * 100 : 0}%`;
    }

    function resetPlaybackUI() {
        S.playbackIndex = 0;
        S.sortedEventsForPlayback = [];
        $('playback-time').textContent = '0 / 0';
        $('playback-progress-bar').style.width = '0%';
        $('play-btn').textContent = '▶️';
        $('play-btn').classList.remove('active');
    }

    // ============================================
    // EVENT DETAILS & STATS
    // ============================================
    function selectEvent(event, isCompare = false) {
        S.selectedEvent = event;
        const cont = isCompare ? '#compare-nodes' : '#event-nodes';
        $$(cont + ' .event-node').forEach(n => n.classList.toggle('selected', n.dataset.eventId === event.id));

        const name = isCompare ? (S.compareUser?.name || 'User') : (S.selectedUser?.name || 'User');
        const color = isCompare ? 'var(--accent2)' : 'var(--accent)';
        $('event-detail').innerHTML = `
            <h3 style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:${color};margin-bottom:12px;">${isCompare ? '📊' : '📝'} ${name}'s Event</h3>
            <div class="event-card ${event.isReply ? 'reply' : 'post'}" style="border-left-color:${color}">
                <div class="event-time" style="color:${color}">${event.isReply ? '↩️ Reply' : '📝 Post'} • ${formatTime(event.created_at)}</div>
                <div class="event-content">${escapeHtml(event.content)}</div>
                <div class="event-meta"><span>ID: ${event.id.slice(0, 8)}...</span>${event.tags?.filter(t => t[0] === 'p').length ? `<span>👥 ${event.tags.filter(t => t[0] === 'p').length} mentions</span>` : ''}</div>
                ${event.parentEventId ? `<div class="thread-info"><span class="thread-icon">↩️</span><span>Reply to ${event.parentEventId.slice(0, 8)}...</span></div>` : ''}
            </div>
            <button class="secondary" style="margin-top:10px;" onclick="renderEventFeed()">← Back to Feed</button>
        `;
    }

    function updateStats() {
        // Update stats header with current time range
        const statsHeader = $('stats-header');
        if (statsHeader) statsHeader.textContent = `📈 ${formatRangeLabel(S.timeRangeHours)} Stats`;
        
        const posts = S.userEvents.filter(e => !e.isReply);
        const replies = S.userEvents.filter(e => e.isReply);
        $('stat-total').textContent = S.userEvents.length;
        $('stat-posts').textContent = posts.length;
        $('stat-replies').textContent = replies.length;

        if (S.userEvents.length) {
            const hours = {};
            S.userEvents.forEach(e => { const h = new Date(e.created_at * 1000).getHours(); hours[h] = (hours[h] || 0) + 1; });
            const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
            $('stat-peak').textContent = `${peak[0]}:00 (${peak[1]} events)`;
        } else $('stat-peak').textContent = '—';

        const threads = S.userEvents.filter(e => e.parentEventId && S.userEvents.some(p => p.id === e.parentEventId)).length;
        $('stat-threads').textContent = threads ? `${threads} visible` : '—';
    }

    function renderEventFeed() {
        const filtered = S.userEvents.filter(e => S.viewMode === 'all' || (S.viewMode === 'posts' ? !e.isReply : e.isReply)).sort((a, b) => b.created_at - a.created_at);
        if (!filtered.length) {
            $('event-detail').innerHTML = '<h3 style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:12px;">📝 Event Feed</h3><div class="empty-state"><div class="icon">📭</div><p>No events in timeframe</p></div>';
            return;
        }
        $('event-detail').innerHTML = `<h3 style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:12px;">📝 Event Feed (${filtered.length})</h3>` +
            filtered.map(e => `
                <div class="event-card ${e.isReply ? 'reply' : 'post'}" data-event-id="${e.id}">
                    <div class="event-time">${e.isReply ? '↩️ Reply' : '📝 Post'} • ${formatTime(e.created_at)}</div>
                    <div class="event-content">${escapeHtml(e.content.slice(0, 300))}${e.content.length > 300 ? '...' : ''}</div>
                    <div class="event-meta"><span>ID: ${e.id.slice(0, 8)}...</span>${e.tags?.filter(t => t[0] === 'p').length ? `<span>👥 ${e.tags.filter(t => t[0] === 'p').length} mentions</span>` : ''}</div>
                    ${e.parentEventId ? `<div class="thread-info"><span class="thread-icon">↩️</span><span>Reply to ${e.parentEventId.slice(0, 8)}...</span>${S.userEvents.find(x => x.id === e.parentEventId) ? '<span style="color:#22c55e">• In view</span>' : ''}</div>` : ''}
                </div>
            `).join('');
        
        // Add click handlers after rendering
        $$('#event-detail .event-card[data-event-id]').forEach(card => {
            card.onclick = () => {
                const event = S.userEvents.find(e => e.id === card.dataset.eventId);
                if (event) selectEvent(event, false);
            };
        });
    }

    // ============================================
    // COMPARE MODE
    // ============================================
    function setupCompareCanvas() {
        S.compareCanvas = $('compare-canvas');
        if (!S.compareCanvas) return;
        S.compareCtx = S.compareCanvas.getContext('2d');
        window.addEventListener('resize', () => { if (S.compareMode) { resizeCompareCanvas(); if (S.compareUser) { drawCompareBackground(); renderCompareTimeline(); } } });
    }

    function resizeCompareCanvas() {
        if (!S.compareCanvas) return;
        const c = $('compare-container');
        S.compareCanvas.width = c.offsetWidth;
        S.compareCanvas.height = c.offsetHeight;
    }

    function toggleCompareMode() {
        S.compareMode = !S.compareMode;
        const app = $('app'), btn = $('compare-toggle'), stats = $('compare-stats');
        if (S.compareMode) {
            app.classList.add('compare-mode');
            btn.classList.add('active');
            btn.innerHTML = '📊 Exit';
            stats.style.display = 'block';
            setTimeout(() => { resizeCompareCanvas(); drawCompareBackground(); const c = $('timeline-canvas'), ctx = c.getContext('2d'), cont = $('canvas-container'); c.width = cont.clientWidth; c.height = cont.clientHeight; drawTimelineBackground(ctx, c.width, c.height); if (S.selectedUser) renderTimeline(); }, 50);
            showToast('📊 Compare mode ON - Click ⚖️ on a user');
        } else {
            app.classList.remove('compare-mode');
            btn.classList.remove('active');
            btn.innerHTML = '📊 Compare';
            stats.style.display = 'none';
            S.compareUser = null;
            S.compareEvents = [];
            S.compareEventPositions.clear();
            initPlayback();
            setTimeout(() => { const c = $('timeline-canvas'), ctx = c.getContext('2d'), cont = $('canvas-container'); c.width = cont.clientWidth; c.height = cont.clientHeight; drawTimelineBackground(ctx, c.width, c.height); if (S.selectedUser) renderTimeline(); }, 50);
        }
        renderUserList();
    }

    function selectCompareUser(pubkey, e) {
        e.stopPropagation();
        if (!S.compareMode || S.selectedUser?.pubkey === pubkey) { showToast('⚠️ Select a different user'); return; }
        S.compareUser = S.users.find(u => u.pubkey === pubkey);
        if (!S.compareUser) return;
        renderUserList();
        fetchCompareUserEvents(pubkey);
        $('compare-user-info').innerHTML = `<span style="color:var(--accent2)">${S.compareUser.name || S.compareUser.npub.slice(0, 12)}</span>`;
    }

    function fetchCompareUserEvents(pubkey) {
        $('compare-nodes').innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';
        S.compareEvents = [];
        S.compareEventPositions.clear();
        const now = Math.floor(Date.now() / 1000);
        const seen = new Set();
        connectToRelays('compare-' + Date.now(), { kinds: [1], authors: [pubkey], since: now - S.timeRangeHours * 3600, limit: CONFIG.EVENT_FETCH_LIMIT }, event => {
            if (seen.has(event.id)) return;
            seen.add(event.id);
            S.compareEvents.push({ ...event, isReply: event.tags.some(t => t[0] === 'e'), parentEventId: event.tags.find(t => t[0] === 'e')?.[1] });
        }, () => { renderCompareTimeline(); updateCompareStats(); initPlayback(); });
    }

    function drawCompareBackground() {
        if (!S.compareCanvas || !S.compareCtx) return;
        const w = S.compareCanvas.width, h = S.compareCanvas.height, cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.35;
        const hours = S.timeRangeHours;
        const tickCount = getTickCount(hours);
        const labelInterval = getLabelInterval(hours);
        
        S.compareCtx.clearRect(0, 0, w, h);
        
        for (let i = 0; i < tickCount; i++) {
            const angle = (i / tickCount) * Math.PI * 2 - Math.PI / 2;
            const isLabel = i % labelInterval === 0;
            S.compareCtx.beginPath();
            S.compareCtx.moveTo(cx + Math.cos(angle) * (r - 10), cy + Math.sin(angle) * (r - 10));
            S.compareCtx.lineTo(cx + Math.cos(angle) * (isLabel ? r + 20 : r + 10), cy + Math.sin(angle) * (isLabel ? r + 20 : r + 10));
            S.compareCtx.strokeStyle = isLabel ? '#8b5cf6' : '#2a2a3a';
            S.compareCtx.lineWidth = isLabel ? 2 : 1;
            S.compareCtx.stroke();
            if (isLabel) {
                const hoursAgo = Math.round((tickCount - i) * (hours / tickCount));
                const label = formatTickLabel(hoursAgo, hours);
                S.compareCtx.font = '11px monospace';
                S.compareCtx.fillStyle = '#555';
                S.compareCtx.textAlign = 'center';
                S.compareCtx.textBaseline = 'middle';
                S.compareCtx.fillText(label, cx + Math.cos(angle) * (r + 35), cy + Math.sin(angle) * (r + 35));
            }
        }
        S.compareCtx.beginPath();
        S.compareCtx.arc(cx, cy, r, 0, Math.PI * 2);
        S.compareCtx.strokeStyle = '#8b5cf6';
        S.compareCtx.lineWidth = 2;
        S.compareCtx.stroke();
        S.compareCtx.beginPath();
        S.compareCtx.arc(cx, cy, 4, 0, Math.PI * 2);
        S.compareCtx.fillStyle = '#8b5cf6';
        S.compareCtx.fill();
        
        // Center label
        S.compareCtx.fillStyle = '#666';
        S.compareCtx.font = '10px monospace';
        S.compareCtx.fillText(formatRangeLabel(hours), cx, cy);
    }

    function renderCompareTimeline() {
        if (!S.compareCanvas) return;
        const nodes = $('compare-nodes');
        nodes.innerHTML = '';
        const c = $('compare-container'), w = c.clientWidth, h = c.clientHeight, cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.35;
        drawCompareBackground();
        S.compareEventPositions.clear();
        const filtered = S.compareEvents.filter(e => S.viewMode === 'all' || (S.viewMode === 'posts' ? !e.isReply : e.isReply)).sort((a, b) => a.created_at - b.created_at);
        if (!filtered.length) { nodes.innerHTML = '<div class="empty-state" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)"><div class="icon">📭</div><p>No events</p></div>'; return; }
        const now = Math.floor(Date.now() / 1000), start = now - S.timeRangeHours * 3600;
        filtered.forEach(e => {
            const progress = (e.created_at - start) / (S.timeRangeHours * 3600);
            const angle = progress * Math.PI * 2 - Math.PI / 2;
            const hash = e.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
            const er = r + ((hash % 40) - 20);
            const x = cx + Math.cos(angle) * er, y = cy + Math.sin(angle) * er;
            S.compareEventPositions.set(e.id, { x, y });
            const node = document.createElement('div');
            node.className = `event-node ${e.isReply ? 'reply' : 'post'}`;
            node.style.left = x + 'px';
            node.style.top = y + 'px';
            node.dataset.eventId = e.id;
            node.title = formatTime(e.created_at) + '\n' + e.content.slice(0, 100);
            node.onclick = () => selectEvent(e, true);
            nodes.appendChild(node);
        });
        if (S.showThreadLines) renderCompareThreadLines();
        $('compare-user-info').textContent = `${S.compareUser?.name || 'User'} — ${filtered.length} events`;
    }

    function renderCompareThreadLines() {
        const svg = $('compare-connections-svg');
        if (!svg) return;
        clearCompareSvgLines();
        const c = $('compare-container'), cx = c.clientWidth / 2, cy = c.clientHeight / 2;
        S.compareEvents.filter(e => S.viewMode === 'all' || (S.viewMode === 'posts' ? !e.isReply : e.isReply)).forEach(e => {
            if (!e.parentEventId) return;
            const pPos = S.compareEventPositions.get(e.parentEventId), cPos = S.compareEventPositions.get(e.id);
            if (!pPos || !cPos) return;
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const midX = (pPos.x + cPos.x) / 2, midY = (pPos.y + cPos.y) / 2;
            path.setAttribute('d', `M ${pPos.x} ${pPos.y} Q ${midX + (cx - midX) * 0.2} ${midY + (cy - midY) * 0.2} ${cPos.x} ${cPos.y}`);
            path.setAttribute('class', 'connection-line compare-thread');
            svg.appendChild(path);
        });
    }

    function clearCompareSvgLines() {
        const svg = $('compare-connections-svg');
        if (svg) svg.querySelectorAll('path').forEach(p => p.remove());
    }

    function updateCompareStats() {
        if (!S.selectedUser || !S.compareUser) return;
        $('compare-name1').textContent = (S.selectedUser.name || 'User 1').slice(0, 8);
        $('compare-name2').textContent = (S.compareUser.name || 'User 2').slice(0, 8);
        const t1 = S.userEvents.length, t2 = S.compareEvents.length;
        $('compare-total1').textContent = t1;
        $('compare-total2').textContent = t2;
        updateBar('compare-bar-total', t1, t2);
        const p1 = S.userEvents.filter(e => !e.isReply).length, p2 = S.compareEvents.filter(e => !e.isReply).length;
        $('compare-posts1').textContent = p1;
        $('compare-posts2').textContent = p2;
        updateBar('compare-bar-posts', p1, p2);
        const r1 = S.userEvents.filter(e => e.isReply).length, r2 = S.compareEvents.filter(e => e.isReply).length;
        $('compare-replies1').textContent = r1;
        $('compare-replies2').textContent = r2;
        updateBar('compare-bar-replies', r1, r2);
        $('compare-activity1').textContent = (t1 / S.timeRangeHours).toFixed(1) + '/h';
        $('compare-activity2').textContent = (t2 / S.timeRangeHours).toFixed(1) + '/h';
    }

    function updateBar(id, v1, v2) {
        const bar = $(id);
        if (!bar) return;
        const total = v1 + v2 || 1;
        bar.querySelector('.bar-user1').style.width = `${(v1 / total) * 100}%`;
        bar.querySelector('.bar-user2').style.width = `${(v2 / total) * 100}%`;
    }

    // ============================================
    // NIP-07 IDENTITY
    // ============================================
    function checkNip07() {
        if (window.nostr) return true;
        const btn = document.querySelector('.identity-btn.login');
        if (btn) { btn.textContent = '🔑 No Extension Found'; btn.title = 'Install Alby, nos2x, etc.'; }
        return false;
    }

    async function loginWithExtension() {
        if (!window.nostr) { showToast('❌ No NIP-07 extension found'); return; }
        try {
            showToast('🔐 Requesting permission...');
            const pubkey = await window.nostr.getPublicKey();
            if (!pubkey) { showToast('❌ Failed to get public key'); return; }
            S.currentIdentity = { pubkey, npub: NostrTools.nip19.npubEncode(pubkey), name: null, picture: null };
            updateIdentityUI();
            localStorage.setItem('nostr_orbit_identity', JSON.stringify(S.currentIdentity));
            fetchIdentityProfile(pubkey);
            showToast('✅ Connected!');
        } catch (e) { showToast('❌ Login cancelled'); }
    }

    function logout() {
        S.currentIdentity = null;
        localStorage.removeItem('nostr_orbit_identity');
        $('identity-logged-in').style.display = 'none';
        $('identity-logged-out').style.display = 'block';
        $('identity-avatar').innerHTML = '👤';
        $('identity-name').textContent = 'Not connected';
        $('identity-npub').textContent = 'Login to import follows';
        showToast('👋 Disconnected');
    }

    function restoreIdentity() {
        const stored = localStorage.getItem('nostr_orbit_identity');
        if (stored) { try { S.currentIdentity = JSON.parse(stored); updateIdentityUI(); fetchIdentityProfile(S.currentIdentity.pubkey); } catch (e) {} }
    }

    function updateIdentityUI() {
        if (!S.currentIdentity) return;
        $('identity-logged-out').style.display = 'none';
        $('identity-logged-in').style.display = 'block';
        $('identity-name').textContent = S.currentIdentity.name || 'Loading...';
        $('identity-npub').textContent = S.currentIdentity.npub.slice(0, 16) + '...';
        if (S.currentIdentity.picture) $('identity-avatar').innerHTML = `<img src="${S.currentIdentity.picture}" alt="avatar" onerror="this.parentElement.innerHTML='👤'">`;
    }

    function fetchIdentityProfile(pubkey) {
        connectToRelays('identity-' + Date.now(), { kinds: [0], authors: [pubkey], limit: 1 }, event => {
            try {
                const p = JSON.parse(event.content);
                if (S.currentIdentity?.pubkey === pubkey) {
                    S.currentIdentity.name = p.display_name || p.name || 'Anonymous';
                    S.currentIdentity.picture = p.picture;
                    localStorage.setItem('nostr_orbit_identity', JSON.stringify(S.currentIdentity));
                    updateIdentityUI();
                }
            } catch (e) {}
        });
    }

    function addMeToList() {
        if (!S.currentIdentity) { showToast('❌ Not logged in'); return; }
        if (S.users.some(u => u.pubkey === S.currentIdentity.pubkey)) { showToast('ℹ️ Already in list!'); return; }
        S.users.push({ 
            npub: S.currentIdentity.npub, 
            pubkey: S.currentIdentity.pubkey, 
            name: S.currentIdentity.name || 'Me', 
            picture: S.currentIdentity.picture, 
            about: null,
            lastActivity: null,
            postCount: 0 
        });
        saveUsers();
        renderUserList();
        showToast('✅ Added yourself!');
    }

    function importFollows() {
        if (!S.currentIdentity) { showToast('❌ Not logged in'); return; }
        showToast('📥 Fetching follows...');
        let done = false;
        connectToRelays('follows-' + Date.now(), { kinds: [3], authors: [S.currentIdentity.pubkey], limit: 1 }, event => {
            if (done) return;
            done = true;
            const pubs = event.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
            if (!pubs.length) { showToast('ℹ️ No follows found'); return; }
            let added = 0;
            pubs.slice(0, CONFIG.MAX_IMPORT_FOLLOWS).forEach(pk => {
                if (S.users.some(u => u.pubkey === pk)) return;
                try { S.users.push({ npub: NostrTools.nip19.npubEncode(pk), pubkey: pk, name: null, picture: null, about: null, lastActivity: null, postCount: 0 }); added++; } catch (e) {}
            });
            saveUsers();
            renderUserList();
            if (added) { showToast(`✅ Imported ${added} follows!`); fetchAllProfiles(); }
            else showToast('ℹ️ All follows already in list');
        });
    }

    // ============================================
    // INIT & EXPOSE
    // ============================================
    function init() {
        setupCanvas();
        setupCompareCanvas();
        loadStoredRelays();
        renderRelayList();
        renderRelayBar();
        updateRelayCount();
        loadStoredUsers();
        if (!S.users.length) loadDefaultUsers();
        renderUserList();
        checkNip07();
        restoreIdentity();
        // Set initial stats header
        const statsHeader = $('stats-header');
        if (statsHeader) statsHeader.textContent = `📈 ${formatRangeLabel(S.timeRangeHours)} Stats`;
    }

    document.addEventListener('DOMContentLoaded', init);

    // Expose to window for HTML onclick handlers
    window.S = S;
    window.toggleRelayManager = toggleRelayManager;
    window.toggleRelay = toggleRelay;
    window.addCustomRelay = addCustomRelay;
    window.addUserFromInput = addUserFromInput;
    window.removeUser = removeUser;
    window.sortUsers = sortUsers;
    window.selectUser = selectUser;
    window.setTimeRange = setTimeRange;
    window.setCustomTimeRange = setCustomTimeRange;
    window.setViewMode = setViewMode;
    window.selectEvent = selectEvent;
    window.renderEventFeed = renderEventFeed;
    window.toggleThreadLines = toggleThreadLines;
    window.togglePlayback = togglePlayback;
    window.resetPlayback = resetPlayback;
    window.seekPlayback = seekPlayback;
    window.cycleSpeed = cycleSpeed;
    window.toggleCompareMode = toggleCompareMode;
    window.selectCompareUser = selectCompareUser;
    window.loginWithExtension = loginWithExtension;
    window.logout = logout;
    window.addMeToList = addMeToList;
    window.importFollows = importFollows;
})();
