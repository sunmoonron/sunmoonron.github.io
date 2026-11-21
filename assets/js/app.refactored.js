// ============================================
// NOSTR ORBIT — Refactored App
// ============================================
//
// Everything this page shows comes from places it does not control: relays
// (profiles, notes, follow lists), localStorage (shared with every other page
// on this origin) and its own input boxes. All of it is treated as hostile.
//
//   1. Nothing from outside is ever parsed as HTML. The page is built with
//      createElement / textContent / DOM properties only (see el() below):
//      this file assigns no innerHTML and never writes a handler attribute.
//      Values are also checked at the door (cleanEvent, cleanText,
//      cleanPictureUrl, cleanRelayUrl, cleanUser, cleanIdentity); whatever
//      does not fit is dropped.
//   2. index.html sets a Content-Security-Policy with script-src 'self', so an
//      inline handler or an injected <script> would not run even if layer 1
//      had a hole. That is why the controls are wired from here, through
//      data-action / data-change attributes and delegated listeners, and why
//      index.html has no on...= attributes.
//
// No secret key is asked for, read or stored anywhere: signing in is NIP-07
// (window.nostr.getPublicKey) and only the public key is kept.

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
        // Limits on what is accepted from relays, localStorage and the input boxes
        MAX_NAME_CHARS: 64,             // A profile name is clipped to this
        MAX_PICTURE_URL_CHARS: 2048,    // A longer picture URL is not used
        MAX_RELAY_URL_CHARS: 255,       // A longer relay URL is refused
        MAX_RELAYS: 30,                 // Relays kept in the list
        MAX_USERS: 500,                 // Users kept in the list
        MAX_FRAME_CHARS: 1048576,       // A longer relay message is ignored
        MAX_FRAMES_PER_SOCKET: 2000,    // A relay that sends more messages than this on one connection is hung up on
        MAX_TIMELINE_EVENTS: 5000,      // Notes kept for one timeline
        MAX_NOTE_CHARS: 20000,          // A longer note is cut
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
        compareRequestId: 0,
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

    const STORE_USERS = 'nostr_orbit_users';
    const STORE_RELAYS = 'nostr_orbit_relays';
    const STORE_IDENTITY = 'nostr_orbit_identity';

    let relays = [];                        // { url, enabled, status }
    const connections = new Map();          // relay url -> Map(channel -> WebSocket)
    const failedPictures = new Set();       // picture URLs that did not load: not asked for again
    let renderTimer = null;
    let toastTimer = null;

    // ============================================
    // UTILITIES
    // ============================================
    const $ = id => document.getElementById(id);
    const $$ = sel => document.querySelectorAll(sel);

    /**
     * A new element. A child that is a string becomes a text node, so nothing
     * passed here is ever parsed as HTML. Class names come from this file only.
     */
    function el(tag, className, ...children) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        for (const child of children) {
            if (child !== null && child !== undefined && child !== false) node.append(child);
        }
        return node;
    }

    /** Inline styles through the style object (fixed values from this file, never outside text). */
    function styled(node, styles) {
        Object.assign(node.style, styles);
        return node;
    }

    /** Mark a node for the delegated click listener: data-action names an entry in ACTIONS. */
    function act(node, action, data) {
        node.dataset.action = action;
        if (data) Object.assign(node.dataset, data);
        return node;
    }

    function emptyState(icon, text) {
        return el('div', 'empty-state', el('div', 'icon', icon), el('p', '', text));
    }

    function formatTime(ts) {
        const diff = Date.now() - ts * 1000;
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function showToast(msg) {
        const t = $('toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove('show'), CONFIG.TOAST_DURATION_MS);
    }

    function npubToHex(input) {
        if (typeof input !== 'string' || input.length > 100) return null;
        try {
            if (input.startsWith('npub1')) {
                const decoded = NostrTools.nip19.decode(input);
                return decoded.type === 'npub' && isHex64(decoded.data) ? decoded.data : null;
            }
            if (/^[0-9a-fA-F]{64}$/.test(input)) return input.toLowerCase();
        } catch (e) {}
        return null;
    }

    function hexToNpub(hex) {
        try { return NostrTools.nip19.npubEncode(hex); }
        catch (e) { return hex.slice(0, 8) + '...' + hex.slice(-4); }
    }

    // localStorage may be unavailable, full, or hold anything at all
    function readStored(key) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? undefined : JSON.parse(raw);
        } catch (e) { return undefined; }
    }

    function writeStored(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }

    function removeStored(key) {
        try { localStorage.removeItem(key); } catch (e) {}
    }

    // ============================================
    // CHECKS AT THE DOOR
    // ============================================
    const HEX64 = /^[0-9a-f]{64}$/;
    const isHex64 = v => typeof v === 'string' && HEX64.test(v);
    const MAX_TIMESTAMP = 8.64e12;          // seconds; beyond this a Date is invalid

    // Control characters become spaces. The bidi embedding / override / isolate characters
    // (U+202A-202E, U+2066-2069), which can reorder the text around them, are removed; that
    // pattern is built from numbers so that none of them ever sits in this file.
    const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;
    const BIDI_CONTROLS = new RegExp('[' + String.fromCharCode(0x202A) + '-' + String.fromCharCode(0x202E) + String.fromCharCode(0x2066) + '-' + String.fromCharCode(0x2069) + ']', 'g');

    /** Text from outside, for display: must be a string; cleaned and clipped to `max` characters. null if nothing is left. */
    function cleanText(value, max) {
        if (typeof value !== 'string') return null;
        const text = value.slice(0, max * 16).replace(BIDI_CONTROLS, '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
        return Array.from(text).slice(0, max).join('').trim() || null;
    }

    /** A picture URL from outside: used only if it parses as an absolute https: URL. Returns it re-serialised, or null. */
    function cleanPictureUrl(value) {
        if (typeof value !== 'string' || !value || value.length > CONFIG.MAX_PICTURE_URL_CHARS) return null;
        let url;
        try { url = new URL(value); } catch (e) { return null; }       // no base given: a relative URL is refused
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
        return url.href.length <= CONFIG.MAX_PICTURE_URL_CHARS ? url.href : null;
    }

    // wss:// + host (+ :port) (+ /path) (+ ?query), from characters that mean nothing to HTML
    const RELAY_URL = /^wss:\/\/(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%!$&*+,;=:@\/-]*)?(?:\?[A-Za-z0-9._~%!$&*+,;=:@\/?-]*)?$/;

    /**
     * A relay URL from outside, or null. It must be wss:// followed by a host.
     * The URL parser does the reading (so "WSS://Relay.Example/" and
     * "wss://relay.example" are the same relay) and the pattern above has the
     * last word. `typed` lets a bare "relay.example" from the input box stand
     * for wss://relay.example, as it always did.
     */
    function cleanRelayUrl(value, typed) {
        if (typeof value !== 'string') return null;
        let text = value.trim();
        if (!text || text.length > CONFIG.MAX_RELAY_URL_CHARS) return null;
        if (typed && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'wss://' + text;
        let url;
        try { url = new URL(text); } catch (e) { return null; }
        if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.hash) return null;
        const clean = 'wss://' + url.host + (url.pathname === '/' && !url.search ? '' : url.pathname) + url.search;
        return clean.length <= CONFIG.MAX_RELAY_URL_CHARS && RELAY_URL.test(clean) ? clean : null;
    }

    /**
     * An event as a relay sent it, or null if it is not shaped like one:
     * id and pubkey 64 lowercase hex characters, kind a small whole number,
     * created_at a finite number, content a string, tags an array of arrays of
     * strings. Only the fields this page uses are kept.
     */
    function cleanEvent(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const { id, pubkey, kind, created_at, content, tags } = raw;
        if (!isHex64(id) || !isHex64(pubkey)) return null;
        if (!Number.isInteger(kind) || kind < 0 || kind > 65535) return null;
        if (typeof created_at !== 'number' || !Number.isFinite(created_at) || created_at < 0 || created_at > MAX_TIMESTAMP) return null;
        if (typeof content !== 'string' || !Array.isArray(tags)) return null;
        for (const tag of tags) {
            if (!Array.isArray(tag)) return null;
            for (const item of tag) if (typeof item !== 'string') return null;
        }
        return { id, pubkey, kind, created_at: Math.floor(created_at), content, tags };
    }

    /**
     * A checked event as a note on `pubkey`'s timeline, or null if it is not
     * what the request asked for (a kind-1 note by that author, inside the
     * requested time range). As before, the main timeline takes a reply's
     * parent from the e tag marked "reply", else the last e tag; the compare
     * timeline (`firstTagIsParent`) takes the first e tag.
     */
    function toNote(event, pubkey, since, until, firstTagIsParent) {
        if (event.kind !== 1 || event.pubkey !== pubkey) return null;
        if (event.created_at < since || event.created_at > until) return null;
        const eTags = event.tags.filter(t => t[0] === 'e');
        const isReply = eTags.length > 0;
        const parent = !isReply ? null
            : firstTagIsParent ? eTags[0][1]
            : (eTags.find(t => t[3] === 'reply')?.[1] || eTags[eTags.length - 1]?.[1]);
        return {
            id: event.id,
            content: event.content.length > CONFIG.MAX_NOTE_CHARS ? event.content.slice(0, CONFIG.MAX_NOTE_CHARS) + '...' : event.content,
            created_at: event.created_at,
            isReply,
            parentEventId: isHex64(parent) ? parent : null,
            mentions: event.tags.filter(t => t[0] === 'p').length
        };
    }

    /** A kind-0 event's content as { name, displayName, picture }, each cleaned or null. null if it is not a JSON object. */
    function parseProfile(content) {
        let p;
        try { p = JSON.parse(content); } catch (e) { return null; }
        if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
        const name = cleanText(p.name, CONFIG.MAX_NAME_CHARS);
        const display = cleanText(p.display_name, CONFIG.MAX_NAME_CHARS);
        return {
            name: name || display || cleanText(p.displayName, CONFIG.MAX_NAME_CHARS),
            displayName: display || name,
            picture: cleanPictureUrl(p.picture)
        };
    }

    function newUser(pubkey, name, picture) {
        return { pubkey, npub: hexToNpub(pubkey), name: name || null, picture: picture || null, lastActivity: null, postCount: 0 };
    }

    /** One stored user, rebuilt from the fields that pass; null without a valid public key. The npub is always derived from it. */
    function cleanUser(raw) {
        if (!raw || typeof raw !== 'object' || !isHex64(raw.pubkey)) return null;
        const user = newUser(raw.pubkey, cleanText(raw.name, CONFIG.MAX_NAME_CHARS), cleanPictureUrl(raw.picture));
        if (typeof raw.lastActivity === 'number' && raw.lastActivity > 0 && raw.lastActivity <= MAX_TIMESTAMP) user.lastActivity = Math.floor(raw.lastActivity);
        if (Number.isSafeInteger(raw.postCount) && raw.postCount > 0) user.postCount = Math.min(raw.postCount, 100000);
        return user;
    }

    /** The stored identity (a public key and what its profile said), or null. */
    function cleanIdentity(raw) {
        if (!raw || typeof raw !== 'object' || !isHex64(raw.pubkey)) return null;
        return {
            pubkey: raw.pubkey,
            npub: hexToNpub(raw.pubkey),
            name: cleanText(raw.name, CONFIG.MAX_NAME_CHARS),
            picture: cleanPictureUrl(raw.picture)
        };
    }

    /** What goes inside an avatar circle: the picture if it is a usable https: URL, else the 👤 fallback. */
    function avatarContent(picture, alt) {
        const src = cleanPictureUrl(picture);
        if (!src || failedPictures.has(src)) return '👤';
        const img = document.createElement('img');
        img.alt = alt || '';
        img.referrerPolicy = 'no-referrer';
        img.dataset.avatar = '';            // a failed load is swapped for 👤 by the error listener in bindControls()
        img.src = src;                      // set as a property, never through markup
        return img;
    }

    // ============================================
    // RELAY MANAGEMENT
    // ============================================
    function loadStoredRelays() {
        relays = [];
        const stored = readStored(STORE_RELAYS);
        if (Array.isArray(stored)) {
            for (const r of stored) {
                const url = r && typeof r === 'object' ? cleanRelayUrl(r.url) : null;
                if (!url || relays.some(x => x.url === url)) continue;
                // Always start as closed, will update when connecting
                relays.push({ url, enabled: r.enabled !== false, status: 'closed' });
                if (relays.length >= CONFIG.MAX_RELAYS) break;
            }
        }
        if (!relays.length) relays = DEFAULT_RELAYS.map(url => ({ url, enabled: true, status: 'closed' }));
        saveRelays();
    }

    function saveRelays() {
        writeStored(STORE_RELAYS, relays.map(r => ({ url: r.url, enabled: r.enabled })));
    }

    function toggleRelayManager() {
        $('relay-manager').classList.toggle('show');
    }

    function renderRelayList() {
        $('relay-list').replaceChildren(...relays.map(r => {
            const url = el('span', 'relay-url', r.url.replace('wss://', ''));
            url.title = r.url;
            const toggle = act(el('button', `relay-toggle ${r.enabled ? 'active' : ''}`, r.enabled ? 'ON' : 'OFF'), 'toggle-relay', { relay: r.url });
            toggle.type = 'button';
            return el('div', 'relay-item', el('div', `relay-dot ${r.status}`), url, toggle);
        }));
    }

    function renderRelayBar() {
        $('relay-bar').replaceChildren(...relays.filter(r => r.enabled).map(r => {
            const chip = el('div', 'relay-chip', el('div', `relay-dot ${r.status}`), r.url.replace('wss://', '').split('/')[0].slice(0, 15));
            chip.title = r.url;
            return chip;
        }));
    }

    function updateRelayCount() {
        $('relay-count').textContent = `${relays.filter(r => r.status === 'connected').length}/${relays.filter(r => r.enabled).length}`;
    }

    function renderRelays() {
        renderRelayList();
        renderRelayBar();
        updateRelayCount();
    }

    function socketsOf(url) {
        let socks = connections.get(url);
        if (!socks) connections.set(url, socks = new Map());
        return socks;
    }

    function closeQuietly(sock) {
        try { sock.close(); } catch (e) {}
    }

    /** What a relay's dot shows: connected while any of its sockets is open, else connecting, else how the last one ended. */
    function updateRelayStatus(relay, ended) {
        let open = false, connecting = false;
        socketsOf(relay.url).forEach(sock => {
            if (sock.readyState === WebSocket.OPEN) open = true;
            else if (sock.readyState === WebSocket.CONNECTING) connecting = true;
        });
        const status = open ? 'connected' : connecting ? 'connecting' : (ended || 'closed');
        if (status === relay.status) return;
        relay.status = status;
        renderRelays();
    }

    function toggleRelay(url) {
        const relay = relays.find(r => r.url === url);
        if (!relay) return;
        relay.enabled = !relay.enabled;
        if (!relay.enabled) {
            const socks = socketsOf(relay.url);
            const open = [...socks.values()];
            socks.clear();
            open.forEach(closeQuietly);
            relay.status = 'closed';
        }
        saveRelays();
        renderRelays();
    }

    function addCustomRelay() {
        const input = $('new-relay-input');
        if (!input.value.trim()) return;
        const url = cleanRelayUrl(input.value, true);
        if (!url) { showToast('⚠️ Enter a wss:// relay address'); return; }
        if (relays.find(r => r.url === url)) { showToast('Relay already added'); return; }
        if (relays.length >= CONFIG.MAX_RELAYS) { showToast(`⚠️ At most ${CONFIG.MAX_RELAYS} relays`); return; }
        relays.push({ url, enabled: true, status: 'closed' });
        saveRelays();
        renderRelays();
        input.value = '';
        showToast('Relay added!');
    }

    /**
     * Ask every enabled relay. `channel` names what the request is for
     * ("profiles", "events", "compare", ...): a new request on a channel
     * replaces that channel's sockets and leaves the other channels alone.
     * onDone runs once, when every relay has answered, refused or gone away.
     */
    function connectToRelays(channel, subId, filter, onEvent, onDone) {
        const enabled = relays.filter(r => r.enabled);
        if (!enabled.length) { if (onDone) onDone(); return; }
        let pending = enabled.length;
        enabled.forEach(relay => {
            connectToRelay(relay, channel, subId, filter, onEvent, () => {
                if (--pending === 0 && onDone) onDone();
            });
        });
    }

    function connectToRelay(relay, channel, subId, filter, onEvent, onDone) {
        const socks = socketsOf(relay.url);

        // Close this channel's earlier connection to the relay before creating a new one
        const previous = socks.get(channel);
        if (previous) { socks.delete(channel); closeQuietly(previous); }

        let finished = false;
        const done = () => { if (!finished) { finished = true; if (onDone) onDone(); } };

        let sock;
        try { sock = new WebSocket(relay.url); }
        catch (e) { updateRelayStatus(relay, 'error'); done(); return; }
        socks.set(channel, sock);
        updateRelayStatus(relay);

        // A socket that has been replaced or switched off no longer speaks for the relay
        const current = () => socks.get(channel) === sock;
        let failed = false;
        let received = 0;

        sock.onopen = () => {
            if (!current()) return;
            updateRelayStatus(relay);
            try { sock.send(JSON.stringify(['REQ', subId, filter])); } catch (e) {}
        };

        sock.onmessage = msg => {
            if (!current()) return;
            if (++received > CONFIG.MAX_FRAMES_PER_SOCKET) { closeQuietly(sock); return; }
            if (typeof msg.data !== 'string' || msg.data.length > CONFIG.MAX_FRAME_CHARS) return;
            let data;
            try { data = JSON.parse(msg.data); } catch (e) { return; }
            if (!Array.isArray(data) || data[1] !== subId) return;
            if (data[0] === 'EVENT') {
                const event = cleanEvent(data[2]);
                if (event) onEvent(event);
            } else if (data[0] === 'EOSE' || data[0] === 'CLOSED') {
                done();
            }
        };

        sock.onerror = () => {
            failed = true;
            if (current()) updateRelayStatus(relay, 'error');
        };

        sock.onclose = () => {
            if (current()) {
                socks.delete(channel);
                updateRelayStatus(relay, failed ? 'error' : 'closed');
            }
            done();
        };

        // Auto-close after timeout to free resources
        setTimeout(() => {
            if (sock.readyState <= WebSocket.OPEN) closeQuietly(sock);
        }, CONFIG.RELAY_TIMEOUT_MS);
    }

    // ============================================
    // USER MANAGEMENT
    // ============================================
    function loadStoredUsers() {
        S.users = [];
        const stored = readStored(STORE_USERS);
        if (!Array.isArray(stored)) return;
        const seen = new Set();
        for (const raw of stored) {
            const user = cleanUser(raw);
            if (!user || seen.has(user.pubkey)) continue;
            seen.add(user.pubkey);
            S.users.push(user);
            if (S.users.length >= CONFIG.MAX_USERS) break;
        }
        if (S.users.length) saveUsers();    // what did not pass is gone from storage too
    }

    function saveUsers() {
        writeStored(STORE_USERS, S.users);
    }

    function loadDefaultUsers() {
        DEFAULT_USERS.forEach(npub => {
            const pubkey = npubToHex(npub);
            if (pubkey) S.users.push(newUser(pubkey));
        });
        saveUsers();
        fetchAllProfiles();
    }

    function addUserFromInput() {
        const input = $('npub-input');
        const val = input.value.trim();
        if (!val) return;
        if (/^nsec1/i.test(val)) {
            // A secret key has no business here: it is not kept, sent or looked at any further
            input.value = '';
            showToast('⚠️ That is a secret key. Never paste it into a page; add the npub');
            return;
        }
        const pubkey = npubToHex(val);
        if (!pubkey) { showToast('Invalid npub or pubkey'); return; }
        if (S.users.find(u => u.pubkey === pubkey)) { showToast('User already added'); return; }
        if (S.users.length >= CONFIG.MAX_USERS) { showToast('⚠️ The list is full'); return; }
        S.users.push(newUser(pubkey));
        saveUsers();
        renderUserList();
        fetchProfile(pubkey);
        input.value = '';
        showToast('User added!');
    }

    function removeUser(pubkey) {
        S.users = S.users.filter(u => u.pubkey !== pubkey);
        saveUsers();
        if (S.selectedUser?.pubkey === pubkey) {
            S.currentRequestId++;           // notes still arriving for this user are no longer wanted
            S.selectedUser = null;
            clearTimeline();
        }
        renderUserList();
    }

    function sortUsers(type) {
        if (type !== 'recent' && type !== 'posts' && type !== 'name') return;
        $$('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === type));
        if (type === 'recent') S.users.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
        else if (type === 'posts') S.users.sort((a, b) => (b.postCount || 0) - (a.postCount || 0));
        else S.users.sort((a, b) => (a.name || a.npub).localeCompare(b.name || b.npub));
        renderUserList();
    }

    function userCard(u) {
        const card = act(el('div', `user-card ${S.selectedUser?.pubkey === u.pubkey ? 'selected' : ''}`,
            el('div', 'user-avatar', avatarContent(u.picture)),
            el('div', 'user-info',
                el('div', 'user-name', u.name || 'Loading...'),
                el('div', 'user-npub', `${u.npub.slice(0, 12)}...${u.npub.slice(-4)}`),
                el('div', 'user-stats', `${u.postCount || 0} posts in ${formatRangeLabel(S.timeRangeHours)}`))
        ), 'select-user', { pubkey: u.pubkey });
        if (S.compareMode) {
            const comparing = S.compareUser?.pubkey === u.pubkey;
            const compare = act(el('button', `user-compare-btn ${comparing ? 'active' : ''}`, comparing ? '📊' : '⚖️'), 'compare-user', { pubkey: u.pubkey });
            compare.type = 'button';
            compare.title = 'Compare';
            card.append(compare);
        }
        const remove = act(el('button', 'user-remove', '×'), 'remove-user', { pubkey: u.pubkey });
        remove.type = 'button';
        card.append(remove);
        return card;
    }

    function renderUserList() {
        const c = $('user-list');
        if (!S.users.length) {
            c.replaceChildren(emptyState('👥', 'Add Nostr users to track their activity'));
            return;
        }
        c.replaceChildren(...S.users.map(userCard));
    }

    function fetchAllProfiles() {
        connectToRelays('profiles', 'profiles', { kinds: [0], authors: S.users.map(u => u.pubkey) }, handleProfile);
    }

    function fetchProfile(pubkey) {
        const sub = 'profile-' + pubkey.slice(0, 8);
        connectToRelays(sub, sub, { kinds: [0], authors: [pubkey] }, handleProfile);
    }

    function handleProfile(event) {
        if (event.kind !== 0) return;
        const user = S.users.find(u => u.pubkey === event.pubkey);
        if (!user) return;
        const profile = parseProfile(event.content);
        if (!profile) return;
        if (user.name === profile.name && user.picture === profile.picture) return;     // the same answer from another relay
        user.name = profile.name;
        user.picture = profile.picture;
        saveUsers();
        renderUserList();
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
        $('selected-user-info').replaceChildren(
            styled(el('span', 'spinner'), { display: 'inline-block', width: '12px', height: '12px', borderWidth: '2px', marginRight: '8px' }),
            'Loading...');

        connectToRelays('events', 'user-events-' + reqId, { kinds: [1], authors: [pubkey], since, until: now, limit: CONFIG.EVENT_FETCH_LIMIT }, event => {
            if (reqId !== S.currentRequestId) return;
            const note = toNote(event, pubkey, since, now);
            if (!note || S.seenEventIds.has(note.id) || S.userEvents.length >= CONFIG.MAX_TIMELINE_EVENTS) return;
            S.seenEventIds.add(note.id);
            if (note.parentEventId) S.parentEvents.set(note.id, note.parentEventId);

            S.userEvents.push(note);

            const user = S.users.find(u => u.pubkey === pubkey);
            if (user) { user.postCount = S.userEvents.length; user.lastActivity = Math.max(user.lastActivity || 0, note.created_at); }

            clearTimeout(renderTimer);
            renderTimer = setTimeout(() => {
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

    function applyTimeRange(hours) {
        S.currentRequestId++;
        S.timeRangeHours = hours;
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

    function setTimeRange(hours) {
        if (!Number.isInteger(hours) || hours < 1 || hours > CONFIG.MAX_TIME_RANGE_HOURS) return;
        $$('.time-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.hours, 10) === hours));
        $('custom-time-input').value = '';
        applyTimeRange(hours);
    }

    function setCustomTimeRange(val) {
        const hours = parseInt(val, 10);
        if (isNaN(hours) || hours < 1) { showToast('⚠️ Enter valid hours'); return; }
        if (hours > CONFIG.MAX_TIME_RANGE_HOURS) { showToast(`⚠️ Max ${CONFIG.MAX_TIME_RANGE_HOURS / 24} days`); return; }
        $$('.time-btn').forEach(b => b.classList.remove('active'));
        applyTimeRange(hours);
        showToast(`⏱️ Showing last ${formatRangeLabel(hours)}`);
    }

    function setViewMode(mode) {
        if (mode !== 'posts' && mode !== 'replies' && mode !== 'all') return;
        S.viewMode = mode;
        $$('.toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
        if (S.selectedUser) { renderTimeline(); updateStats(); renderEventFeed(); }
        if (S.compareMode && S.compareUser) renderCompareTimeline();
    }

    // ============================================
    // TIMELINE VISUALIZATION
    // ============================================
    function resizeMainCanvas() {
        const canvas = $('timeline-canvas');
        const c = $('canvas-container');
        canvas.width = c.clientWidth;
        canvas.height = c.clientHeight;
        drawTimelineBackground(canvas.getContext('2d'), canvas.width, canvas.height);
    }

    function setupCanvas() {
        resizeMainCanvas();
        window.addEventListener('resize', resizeMainCanvas);
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

    function inViewMode(e) {
        return S.viewMode === 'all' || (S.viewMode === 'posts' ? !e.isReply : e.isReply);
    }

    /** How many of these notes reply to another note in the same list. */
    function countThreads(events) {
        const ids = new Set(events.map(e => e.id));
        return events.filter(e => e.parentEventId && ids.has(e.parentEventId)).length;
    }

    function renderTimeline() {
        const container = $('canvas-container');
        const nodes = $('event-nodes');
        nodes.replaceChildren();
        S.eventPositions.clear();
        clearSvgLines();

        const w = container.clientWidth, h = container.clientHeight;
        const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.35;

        const filtered = S.userEvents.filter(inViewMode);
        filtered.sort((a, b) => a.created_at - b.created_at);
        const shown = new Set(filtered.map(e => e.id));

        const now = Math.floor(Date.now() / 1000);
        const rangeStart = now - S.timeRangeHours * 3600;

        filtered.forEach(event => {
            const progress = (event.created_at - rangeStart) / (S.timeRangeHours * 3600);
            const angle = progress * Math.PI * 2 - Math.PI / 2;
            const hash = event.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
            const er = r + ((hash % 20) - 10);
            const x = cx + Math.cos(angle) * er;
            const y = cy + Math.sin(angle) * er;

            // Check if this event has a visible thread connection
            const hasVisibleThread = event.parentEventId && shown.has(event.parentEventId);

            const node = act(el('div', `event-node ${event.isReply ? 'reply' : 'post'}${hasVisibleThread ? ' has-thread' : ''}`), 'select-event', { eventId: event.id });
            node.style.left = x + 'px';
            node.style.top = y + 'px';
            node.title = formatTime(event.created_at) + '\n' + event.content.slice(0, 100);
            node.addEventListener('mouseenter', () => highlightThread(event));
            node.addEventListener('mouseleave', clearThreadHighlight);
            nodes.appendChild(node);

            S.eventPositions.set(event.id, { x, y, node });
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
        // Up through the parents, then down through the replies. A relay can claim any parent it likes, so a loop must not hang the page.
        const ids = new Set();
        for (let cur = event.id; cur && !ids.has(cur); cur = S.parentEvents.get(cur)) ids.add(cur);
        const queue = [event.id];
        while (queue.length) {
            const pid = queue.pop();
            S.userEvents.forEach(e => { if (e.parentEventId === pid && !ids.has(e.id)) { ids.add(e.id); queue.push(e.id); } });
        }

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

    function feedHeading(text, color) {
        return styled(el('h3', '', text), { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', color: color || '#666', marginBottom: '12px' });
    }

    function clearTimeline() {
        const canvas = $('timeline-canvas');
        drawTimelineBackground(canvas.getContext('2d'), canvas.width, canvas.height);
        $('event-nodes').replaceChildren();
        clearSvgLines();
        S.eventPositions.clear();
        S.parentEvents.clear();
        const btn = $('thread-toggle');
        if (btn) btn.textContent = '🔗 Show Threads';
        stopPlayback();
        resetPlaybackUI();
        $('event-detail').replaceChildren(feedHeading('📝 Event Feed'), emptyState('🔭', 'Select a user to view their events'));
    }

    function toggleThreadLines() {
        S.showThreadLines = !S.showThreadLines;
        const btn = $('thread-toggle');
        btn.classList.toggle('active', S.showThreadLines);

        // Count threads for both main and compare views
        const threads = countThreads(S.userEvents) + (S.compareMode ? countThreads(S.compareEvents) : 0);

        btn.textContent = S.showThreadLines ? `🔗 Hide (${threads})` : '🔗 Threads';
        if (S.showThreadLines && S.userEvents.length) { renderTimeline(); if (S.compareMode && S.compareEvents.length) renderCompareThreadLines(); }
        else { clearSvgLines(); clearCompareSvgLines(); }
    }

    // ============================================
    // PLAYBACK
    // ============================================
    function initPlayback() {
        let events = S.userEvents.filter(inViewMode).map(e => ({ ...e, isCompareEvent: false }));
        if (S.compareMode && S.compareEvents.length) {
            events = [...events, ...S.compareEvents.filter(inViewMode).map(e => ({ ...e, isCompareEvent: true }))];
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

        // The node is looked up in the positions map: an event id is never put into a selector
        const positions = event.isCompareEvent ? S.compareEventPositions : S.eventPositions;
        const node = positions.get(event.id)?.node;
        if (node) {
            node.classList.remove('hidden');
            node.classList.add('animated-in');

            // Draw thread line if applicable and threads are enabled
            if (S.showThreadLines && event.parentEventId) {
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

        const order = new Map();
        S.sortedEventsForPlayback.forEach((ev, i) => { if (!order.has(ev.id)) order.set(ev.id, i); });
        $$('.event-node').forEach(n => {
            const idx = order.has(n.dataset.eventId) ? order.get(n.dataset.eventId) : -1;
            if (idx >= 0 && idx < S.playbackIndex) n.classList.remove('hidden', 'animated-in');
            else if (idx >= S.playbackIndex) { n.classList.add('hidden'); n.classList.remove('animated-in'); }
        });

        // Redraw thread lines for visible events if enabled
        if (S.showThreadLines) {
            clearSvgLines();
            clearCompareSvgLines();
            const visibleEvents = S.sortedEventsForPlayback.slice(0, S.playbackIndex);
            const mainVisible = visibleEvents.filter(ev => !ev.isCompareEvent);
            const compareVisible = visibleEvents.filter(ev => ev.isCompareEvent);
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
    function eventMeta(event) {
        return el('div', 'event-meta',
            el('span', '', `ID: ${event.id.slice(0, 8)}...`),
            event.mentions ? el('span', '', `👥 ${event.mentions} mentions`) : null);
    }

    function threadInfo(event, inView) {
        if (!event.parentEventId) return null;
        return el('div', 'thread-info',
            el('span', 'thread-icon', '↩️'),
            el('span', '', `Reply to ${event.parentEventId.slice(0, 8)}...`),
            inView ? styled(el('span', '', '• In view'), { color: '#22c55e' }) : null);
    }

    function selectEvent(event, isCompare = false) {
        S.selectedEvent = event;
        const cont = isCompare ? '#compare-nodes' : '#event-nodes';
        $$(cont + ' .event-node').forEach(n => n.classList.toggle('selected', n.dataset.eventId === event.id));

        const name = isCompare ? (S.compareUser?.name || 'User') : (S.selectedUser?.name || 'User');
        const color = isCompare ? 'var(--accent2)' : 'var(--accent)';
        const card = el('div', `event-card ${event.isReply ? 'reply' : 'post'}`,
            styled(el('div', 'event-time', `${event.isReply ? '↩️ Reply' : '📝 Post'} • ${formatTime(event.created_at)}`), { color }),
            el('div', 'event-content', event.content),
            eventMeta(event),
            threadInfo(event, false));
        card.style.borderLeftColor = color;
        const back = act(styled(el('button', 'secondary', '← Back to Feed'), { marginTop: '10px' }), 'back-to-feed');
        back.type = 'button';
        $('event-detail').replaceChildren(feedHeading(`${isCompare ? '📊' : '📝'} ${name}'s Event`, color), card, back);
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

        const threads = countThreads(S.userEvents);
        $('stat-threads').textContent = threads ? `${threads} visible` : '—';
    }

    function renderEventFeed() {
        const filtered = S.userEvents.filter(inViewMode).sort((a, b) => b.created_at - a.created_at);
        if (!filtered.length) {
            $('event-detail').replaceChildren(feedHeading('📝 Event Feed'), emptyState('📭', 'No events in timeframe'));
            return;
        }
        const loaded = new Set(S.userEvents.map(e => e.id));
        $('event-detail').replaceChildren(
            feedHeading(`📝 Event Feed (${filtered.length})`),
            ...filtered.map(e => act(el('div', `event-card ${e.isReply ? 'reply' : 'post'}`,
                el('div', 'event-time', `${e.isReply ? '↩️ Reply' : '📝 Post'} • ${formatTime(e.created_at)}`),
                el('div', 'event-content', e.content.slice(0, 300) + (e.content.length > 300 ? '...' : '')),
                eventMeta(e),
                threadInfo(e, loaded.has(e.parentEventId))
            ), 'select-event', { eventId: e.id })));
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
            btn.textContent = '📊 Exit';
            stats.style.display = 'block';
            setTimeout(() => { resizeCompareCanvas(); drawCompareBackground(); resizeMainCanvas(); if (S.selectedUser) renderTimeline(); }, 50);
            showToast('📊 Compare mode ON - Click ⚖️ on a user');
        } else {
            app.classList.remove('compare-mode');
            btn.classList.remove('active');
            btn.textContent = '📊 Compare';
            stats.style.display = 'none';
            S.compareRequestId++;           // notes still arriving for the compared user are no longer wanted
            S.compareUser = null;
            S.compareEvents = [];
            S.compareEventPositions.clear();
            initPlayback();
            setTimeout(() => { resizeMainCanvas(); if (S.selectedUser) renderTimeline(); }, 50);
        }
        renderUserList();
    }

    function selectCompareUser(pubkey) {
        if (!S.compareMode || S.selectedUser?.pubkey === pubkey) { showToast('⚠️ Select a different user'); return; }
        const user = S.users.find(u => u.pubkey === pubkey);
        if (!user) return;
        S.compareUser = user;
        renderUserList();
        fetchCompareUserEvents(pubkey);
        $('compare-user-info').replaceChildren(styled(el('span', '', user.name || user.npub.slice(0, 12)), { color: 'var(--accent2)' }));
    }

    function fetchCompareUserEvents(pubkey) {
        const reqId = ++S.compareRequestId;
        $('compare-nodes').replaceChildren(el('div', 'loading', el('div', 'spinner'), 'Loading...'));
        S.compareEvents = [];
        S.compareEventPositions.clear();
        const now = Math.floor(Date.now() / 1000);
        const since = now - S.timeRangeHours * 3600;
        const seen = new Set();
        connectToRelays('compare', 'compare-' + reqId, { kinds: [1], authors: [pubkey], since, until: now, limit: CONFIG.EVENT_FETCH_LIMIT }, event => {
            if (reqId !== S.compareRequestId) return;
            const note = toNote(event, pubkey, since, now, true);
            if (!note || seen.has(note.id) || S.compareEvents.length >= CONFIG.MAX_TIMELINE_EVENTS) return;
            seen.add(note.id);
            S.compareEvents.push(note);
        }, () => {
            if (reqId !== S.compareRequestId) return;
            renderCompareTimeline();
            updateCompareStats();
            initPlayback();
        });
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
        nodes.replaceChildren();
        const c = $('compare-container'), w = c.clientWidth, h = c.clientHeight, cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.35;
        drawCompareBackground();
        S.compareEventPositions.clear();
        const filtered = S.compareEvents.filter(inViewMode).sort((a, b) => a.created_at - b.created_at);
        if (!filtered.length) {
            nodes.replaceChildren(styled(emptyState('📭', 'No events'), { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }));
            return;
        }
        const now = Math.floor(Date.now() / 1000), start = now - S.timeRangeHours * 3600;
        filtered.forEach(e => {
            const progress = (e.created_at - start) / (S.timeRangeHours * 3600);
            const angle = progress * Math.PI * 2 - Math.PI / 2;
            const hash = e.id.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
            const er = r + ((hash % 40) - 20);
            const x = cx + Math.cos(angle) * er, y = cy + Math.sin(angle) * er;
            const node = act(el('div', `event-node ${e.isReply ? 'reply' : 'post'}`), 'select-event', { eventId: e.id });
            node.style.left = x + 'px';
            node.style.top = y + 'px';
            node.title = formatTime(e.created_at) + '\n' + e.content.slice(0, 100);
            nodes.appendChild(node);
            S.compareEventPositions.set(e.id, { x, y, node });
        });
        if (S.showThreadLines) renderCompareThreadLines();
        $('compare-user-info').textContent = `${S.compareUser?.name || 'User'} — ${filtered.length} events`;
    }

    function renderCompareThreadLines() {
        const svg = $('compare-connections-svg');
        if (!svg) return;
        clearCompareSvgLines();
        const c = $('compare-container'), cx = c.clientWidth / 2, cy = c.clientHeight / 2;
        S.compareEvents.filter(inViewMode).forEach(e => {
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
            // The extension keeps the key; this page only ever asks for the public half
            const answer = await window.nostr.getPublicKey();
            const pubkey = typeof answer === 'string' ? answer.toLowerCase() : '';
            if (!isHex64(pubkey)) { showToast('❌ Failed to get public key'); return; }
            S.currentIdentity = { pubkey, npub: hexToNpub(pubkey), name: null, picture: null };
            updateIdentityUI();
            writeStored(STORE_IDENTITY, S.currentIdentity);
            fetchIdentityProfile(pubkey);
            showToast('✅ Connected!');
        } catch (e) { showToast('❌ Login cancelled'); }
    }

    function logout() {
        S.currentIdentity = null;
        removeStored(STORE_IDENTITY);
        $('identity-logged-in').style.display = 'none';
        $('identity-logged-out').style.display = 'block';
        $('identity-avatar').textContent = '👤';
        $('identity-name').textContent = 'Not connected';
        $('identity-npub').textContent = 'Login to import follows';
        showToast('👋 Disconnected');
    }

    function restoreIdentity() {
        const stored = readStored(STORE_IDENTITY);
        if (stored === undefined) return;
        S.currentIdentity = cleanIdentity(stored);
        if (!S.currentIdentity) { removeStored(STORE_IDENTITY); return; }
        writeStored(STORE_IDENTITY, S.currentIdentity);
        updateIdentityUI();
        fetchIdentityProfile(S.currentIdentity.pubkey);
    }

    function updateIdentityUI() {
        if (!S.currentIdentity) return;
        $('identity-logged-out').style.display = 'none';
        $('identity-logged-in').style.display = 'block';
        $('identity-name').textContent = S.currentIdentity.name || 'Loading...';
        $('identity-npub').textContent = S.currentIdentity.npub.slice(0, 16) + '...';
        if (S.currentIdentity.picture) $('identity-avatar').replaceChildren(avatarContent(S.currentIdentity.picture, 'avatar'));
    }

    function fetchIdentityProfile(pubkey) {
        connectToRelays('identity', 'identity-' + Date.now(), { kinds: [0], authors: [pubkey], limit: 1 }, event => {
            if (event.kind !== 0 || event.pubkey !== pubkey || S.currentIdentity?.pubkey !== pubkey) return;
            const profile = parseProfile(event.content);
            if (!profile) return;
            const name = profile.displayName || 'Anonymous';
            if (S.currentIdentity.name === name && S.currentIdentity.picture === profile.picture) return;
            S.currentIdentity.name = name;
            S.currentIdentity.picture = profile.picture;
            writeStored(STORE_IDENTITY, S.currentIdentity);
            updateIdentityUI();
        });
    }

    function addMeToList() {
        if (!S.currentIdentity) { showToast('❌ Not logged in'); return; }
        if (S.users.some(u => u.pubkey === S.currentIdentity.pubkey)) { showToast('ℹ️ Already in list!'); return; }
        if (S.users.length >= CONFIG.MAX_USERS) { showToast('⚠️ The list is full'); return; }
        S.users.push(newUser(S.currentIdentity.pubkey, S.currentIdentity.name || 'Me', S.currentIdentity.picture));
        saveUsers();
        renderUserList();
        showToast('✅ Added yourself!');
    }

    function importFollows() {
        if (!S.currentIdentity) { showToast('❌ Not logged in'); return; }
        showToast('📥 Fetching follows...');
        const me = S.currentIdentity.pubkey;
        let done = false;
        connectToRelays('follows', 'follows-' + Date.now(), { kinds: [3], authors: [me], limit: 1 }, event => {
            if (done || event.kind !== 3 || event.pubkey !== me) return;
            done = true;
            const pubs = [...new Set(event.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1].toLowerCase()).filter(isHex64))];
            if (!pubs.length) { showToast('ℹ️ No follows found'); return; }
            let added = 0;
            pubs.slice(0, CONFIG.MAX_IMPORT_FOLLOWS).forEach(pk => {
                if (S.users.length >= CONFIG.MAX_USERS || S.users.some(u => u.pubkey === pk)) return;
                S.users.push(newUser(pk));
                added++;
            });
            saveUsers();
            renderUserList();
            if (added) { showToast(`✅ Imported ${added} follows!`); fetchAllProfiles(); }
            else showToast('ℹ️ All follows already in list');
        });
    }

    // ============================================
    // CONTROLS
    // ============================================
    // index.html and the nodes built above carry data-action / data-change
    // instead of handler attributes (the page's CSP would not run those). One
    // listener per event type routes them through these fixed tables; a name
    // that is not listed here does nothing.
    const ACTIONS = new Map([
        ['login', () => loginWithExtension()],
        ['import-follows', () => importFollows()],
        ['add-me', () => addMeToList()],
        ['logout', () => logout()],
        ['add-user', () => addUserFromInput()],
        ['sort', t => sortUsers(t.dataset.sort)],
        ['time-range', t => setTimeRange(parseInt(t.dataset.hours, 10))],
        ['toggle-relay-manager', () => toggleRelayManager()],
        ['add-relay', () => addCustomRelay()],
        ['toggle-relay', t => toggleRelay(t.dataset.relay)],
        ['toggle-threads', () => toggleThreadLines()],
        ['toggle-compare', () => toggleCompareMode()],
        ['playback-reset', () => resetPlayback()],
        ['playback-toggle', () => togglePlayback()],
        ['playback-seek', (t, e) => seekPlayback(e)],
        ['playback-speed', () => cycleSpeed()],
        ['view-mode', t => setViewMode(t.dataset.view)],
        ['select-user', t => selectUser(t.dataset.pubkey)],
        ['compare-user', t => selectCompareUser(t.dataset.pubkey)],
        ['remove-user', t => removeUser(t.dataset.pubkey)],
        ['back-to-feed', () => renderEventFeed()],
        ['select-event', t => {
            const isCompare = !!t.closest('#compare-nodes');
            const event = (isCompare ? S.compareEvents : S.userEvents).find(e => e.id === t.dataset.eventId);
            if (event) selectEvent(event, isCompare);
        }],
    ]);

    const CHANGES = new Map([
        ['custom-time', t => setCustomTimeRange(t.value)],
    ]);

    function bindControls() {
        // The innermost marked element wins, so a button inside a user card does not also select the card
        document.addEventListener('click', e => {
            const target = e.target instanceof Element ? e.target.closest('[data-action]') : null;
            const run = target && ACTIONS.get(target.dataset.action);
            if (run) run(target, e);
        });

        document.addEventListener('change', e => {
            const target = e.target instanceof Element ? e.target.closest('[data-change]') : null;
            const run = target && CHANGES.get(target.dataset.change);
            if (run) run(target, e);
        });

        // error does not bubble, so this listens on the way down: an avatar that fails to load becomes 👤
        document.addEventListener('error', e => {
            const img = e.target;
            if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-avatar')) return;
            if (failedPictures.size >= 500) failedPictures.clear();
            failedPictures.add(img.getAttribute('src'));
            if (img.parentElement) img.parentElement.textContent = '👤';
        }, true);
    }

    // ============================================
    // INIT
    // ============================================
    function init() {
        bindControls();
        setupCanvas();
        setupCompareCanvas();
        loadStoredRelays();
        renderRelays();
        loadStoredUsers();
        if (!S.users.length) loadDefaultUsers();
        renderUserList();
        checkNip07();
        restoreIdentity();
        // Set initial stats header
        const statsHeader = $('stats-header');
        if (statsHeader) statsHeader.textContent = `📈 ${formatRangeLabel(S.timeRangeHours)} Stats`;
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
