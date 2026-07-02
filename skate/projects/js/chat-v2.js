/**
 * SkateChat v2 — same public API as v1, rebuilt internals.
 *
 * What changed and why (the v1 bug ledger):
 *  1. Event kinds moved OUT of the ephemeral range. v1 used kinds 20100-20103,
 *     which relays forward but never store — chat history vanished on reload
 *     and DMs to offline people were lost forever. v2 uses kind 42 for group
 *     traffic and kind 4 for DMs (both verified stored on damus/nos.lol/primal).
 *     Presence stays ephemeral (kind 20104) — that's the one thing v1 got right.
 *  2. Identity moved from sessionStorage to localStorage. v1 minted a new
 *     keypair + name every browser session, so DM threads pointed at dead
 *     pubkeys within a day.
 *  3. One shared relay pool (SkateNostr) instead of 3 sockets per group —
 *     kills the zombie-reconnect loop in v1's onclose handler and the
 *     socket explosion.
 *  4. DMs are independent of groups: subscribed by #p on your pubkey, so they
 *     arrive even if you share no group and even if sent while you're offline.
 *  5. Votes keyed by stable programId + voter pubkey (v1 keyed them by the
 *     *filtered list index* — change a filter and votes attached to the wrong
 *     programs — and by display name, which collides).
 *  6. Unread via lastReadTs (replay-safe) instead of increment-on-arrival.
 *  7. Send pipeline: moderation check -> PoW -> publish with relay-OK
 *     tracking -> message shows pending/sent/failed instead of silently dying.
 *  8. notifyUpdate throttled + saveState debounced: v1 re-rendered the whole
 *     app and rewrote localStorage on every presence ping (every 30s x member).
 */
const SkateChat = (() => {
    'use strict';

    const CONFIG = {
        KINDS: { GROUP: 42, DM: 4, PRESENCE: 20104 },
        MAX_GROUPS: 10,
        MAX_MESSAGES: 200,
        MAX_MESSAGE_LENGTH: 500,
        STORAGE_KEY: 'skate_chat_v7',
        IDENTITY_KEY: 'skate_identity_v1',
        FAVORITES_KEY: 'skate_favorites_v2',
        PRESENCE_INTERVAL: 45000,
        ONLINE_WINDOW: 90000,
        BACKFILL_DAYS: 7
    };

    const PUBLIC_ROOMS = {
        leisure: { name: 'Leisure Skating', passphrase: 'toronto-leisure-skate-public-2025', emoji: '⛸️', desc: 'Casual skating & fun' },
        shinny:  { name: 'Shinny Hockey',   passphrase: 'toronto-shinny-hockey-public-2025', emoji: '🏒', desc: 'Drop-in hockey games' },
        figure:  { name: 'Figure Skating',  passphrase: 'toronto-figure-skate-public-2025', emoji: '⛸️', desc: 'Spins, jumps & grace' },
        general: { name: 'General Chat',    passphrase: 'toronto-skating-general-public-2025', emoji: '💬', desc: 'Help, tips & chill' },
        newbies: { name: 'New Skaters',     passphrase: 'toronto-new-skaters-public-2026', emoji: '🐣', desc: 'First laps, zero judgement' }
    };

    const ADJECTIVES = ['Swift', 'Gliding', 'Frozen', 'Quick', 'Cool', 'Icy', 'Smooth', 'Fast', 'Chill', 'Frosty'];
    const NOUNS = ['Skater', 'Penguin', 'Blade', 'Tiger', 'Bear', 'Fox', 'Wolf', 'Hawk', 'Star', 'Flash'];

    const state = {
        myName: null, mySecretKey: null, myPublicKey: null,
        groups: {},         // private groups: id -> group
        publicRooms: {},    // joined public rooms: id -> group
        activeGroupId: null, activeIsPublic: false,
        dmThreads: {},      // pubkey -> { name, messages[], lastReadTs }
        activeDmRecipient: null,
        callbacks: [],
        presenceTimer: null,
        favorites: new Set(),
        publicRoomSecrets: {},
        subGeneration: 0
    };

    // ========== NOTIFICATIONS (unchanged surface) ==========
    const Notify = {
        browser(title, body, onClick = null) {
            if (!('Notification' in window)) return;
            if (Notification.permission !== 'granted' || document.hasFocus()) return;
            try {
                const n = new Notification(title, { body, tag: 'skate-chat' });
                if (onClick) n.onclick = onClick;
                setTimeout(() => n.close(), 5000);
            } catch {}
        },
        toast(message, type = 'info', duration = 4000) {
            const container = document.getElementById('toast-container') || this._createContainer();
            const el = document.createElement('div');
            el.className = `toast toast-${type}`;
            el.innerHTML = `<span></span><button>✕</button>`;
            el.querySelector('span').textContent = message;
            el.querySelector('button').onclick = () => el.remove();
            container.appendChild(el);
            setTimeout(() => el.classList.add('show'), 10);
            setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, duration);
        },
        _createContainer() {
            const c = document.createElement('div');
            c.id = 'toast-container';
            document.body.appendChild(c);
            return c;
        },
        updateTitle(unread) {
            document.title = unread > 0 ? `(${unread}) Toronto Skating` : 'Toronto Skating';
        }
    };

    // ========== FAVORITES (unchanged behaviour, stable IDs) ==========
    const Favorites = {
        load() {
            try {
                const saved = localStorage.getItem(CONFIG.FAVORITES_KEY);
                if (saved) state.favorites = new Set(JSON.parse(saved));
            } catch {}
        },
        save() {
            try { localStorage.setItem(CONFIG.FAVORITES_KEY, JSON.stringify([...state.favorites])); } catch {}
        },
        getId(program) {
            const activity = program.Activity || program['Activity Title'] || '';
            const location = program.LocationName || program['Location Name'] || '';
            const date = program['Start Date Time'] || program['Start Date'] || '';
            const time = program['Start Time'] || '';
            return Crypto.hashSync(`${activity}|${location}|${date}|${time}`).slice(0, 16);
        },
        toggle(program) {
            const id = this.getId(program);
            if (state.favorites.has(id)) { state.favorites.delete(id); Notify.toast('Removed from saved', 'info', 2000); }
            else { state.favorites.add(id); Notify.toast('Saved ❤️', 'success', 2000); }
            this.save();
            return state.favorites.has(id);
        },
        has(program) { return state.favorites.has(this.getId(program)); },
        count() { return state.favorites.size; }
    };

    // ========== CRYPTO ==========
    const Crypto = {
        randomHex(bytes = 32) {
            const arr = new Uint8Array(bytes);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        },
        async sha256(data) {
            const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
            return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        },
        hashSync(str) {
            let hash = 0x811c9dc5;
            for (let i = 0; i < str.length; i++) { hash ^= str.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
            let result = '';
            for (let round = 0; round < 4; round++) {
                hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
                hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
                hash ^= hash >>> 16;
                result += (hash >>> 0).toString(16).padStart(8, '0');
            }
            return result;
        },
        deriveGroupId(secret) { return this.hashSync(secret).slice(0, 12); },
        groupKey(groupSecretHex) {
            const sk = this.hexToBytes(groupSecretHex.slice(0, 64));
            const pk = NostrTools.getPublicKey(sk);
            return NostrTools.nip44.getConversationKey(sk, pk);
        },
        encryptForGroup(plaintext, secret) { return NostrTools.nip44.encrypt(plaintext, this.groupKey(secret)); },
        decryptForGroup(ciphertext, secret) {
            try { return NostrTools.nip44.decrypt(ciphertext, this.groupKey(secret)); } catch { return null; }
        },
        encryptDm(plaintext, mySk, theirPk) {
            return NostrTools.nip44.encrypt(plaintext, NostrTools.nip44.getConversationKey(mySk, theirPk));
        },
        decryptDm(ciphertext, mySk, theirPk) {
            try { return NostrTools.nip44.decrypt(ciphertext, NostrTools.nip44.getConversationKey(mySk, theirPk)); }
            catch { return null; }
        },
        hexToBytes(hex) {
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            return bytes;
        },
        bytesToHex(bytes) { return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''); }
    };

    // ========== IDENTITY (localStorage — stable across sessions) ==========
    function initIdentity() {
        try {
            const saved = localStorage.getItem(CONFIG.IDENTITY_KEY);
            if (saved) {
                const p = JSON.parse(saved);
                state.mySecretKey = Crypto.hexToBytes(p.sk);
                state.myPublicKey = p.pk;
                state.myName = p.name;
            }
        } catch {}
        if (!state.mySecretKey) {
            state.mySecretKey = NostrTools.generateSecretKey();
            state.myPublicKey = NostrTools.getPublicKey(state.mySecretKey);
        }
        const preferred = window.SkateSettings?.get('displayName');
        if (preferred) state.myName = preferred;
        if (!state.myName) {
            state.myName = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] +
                           NOUNS[Math.floor(Math.random() * NOUNS.length)] +
                           Math.floor(Math.random() * 100);
        }
        saveIdentity();
    }

    function saveIdentity() {
        try {
            localStorage.setItem(CONFIG.IDENTITY_KEY, JSON.stringify({
                sk: Crypto.bytesToHex(state.mySecretKey), pk: state.myPublicKey, name: state.myName
            }));
        } catch {}
    }

    function setDisplayName(name) {
        const clean = (name || '').trim().slice(0, 24);
        if (!clean || SkateMod.checkLocal(clean)) return false;
        state.myName = clean;
        saveIdentity();
        window.SkateSettings?.set('displayName', clean);
        notifyUpdate();
        return true;
    }

    // ========== PERSISTENCE (debounced) ==========
    let saveTimer = null;
    function saveState(immediate = false) {
        if (saveTimer) clearTimeout(saveTimer);
        const write = () => {
            saveTimer = null;
            try {
                const slim = (groups) => {
                    const out = {};
                    for (const [id, g] of Object.entries(groups)) {
                        out[id] = { ...g, messages: g.messages.slice(-CONFIG.MAX_MESSAGES), _online: undefined };
                    }
                    return out;
                };
                localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
                    groups: slim(state.groups),
                    publicRooms: slim(state.publicRooms),
                    publicRoomSecrets: state.publicRoomSecrets,
                    dmThreads: state.dmThreads,
                    activeGroupId: state.activeGroupId,
                    activeIsPublic: state.activeIsPublic
                }));
            } catch (e) { console.warn('[SkateChat] save error:', e); }
        };
        immediate ? write() : (saveTimer = setTimeout(write, 500));
    }

    function loadState() {
        try {
            const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (!saved) return;
            const p = JSON.parse(saved);
            state.groups = p.groups || {};
            state.publicRooms = p.publicRooms || {};
            state.publicRoomSecrets = p.publicRoomSecrets || {};
            state.dmThreads = p.dmThreads || {};
            state.activeGroupId = p.activeGroupId || null;
            state.activeIsPublic = p.activeIsPublic || false;
            Object.values(state.groups).concat(Object.values(state.publicRooms)).forEach(g => {
                g.connected = false;
                g._online = {};
            });
        } catch (e) { console.warn('[SkateChat] load error:', e); }
    }

    // ========== UPDATE FANOUT (throttled) ==========
    let notifyPending = false;
    function notifyUpdate() {
        if (notifyPending) return;
        notifyPending = true;
        requestAnimationFrame(() => {
            notifyPending = false;
            const s = getState();
            state.callbacks.forEach(cb => { try { cb(s); } catch {} });
        });
    }

    // ========== SUBSCRIPTIONS ==========
    function allGroupIds() { return [...Object.keys(state.groups), ...Object.keys(state.publicRooms)]; }
    function getGroupOrRoom(id) { return state.groups[id] || state.publicRooms[id] || null; }

    function oldestNeededSince() {
        let since = Math.floor(Date.now() / 1000) - CONFIG.BACKFILL_DAYS * 86400;
        allGroupIds().forEach(id => {
            const g = getGroupOrRoom(id);
            const last = g?.messages?.length ? Math.floor(g.messages[g.messages.length - 1].ts / 1000) - 60 : 0;
            if (last && last < since) since = last;
        });
        return since;
    }

    function resubscribe() {
        const gen = ++state.subGeneration;
        const gids = allGroupIds();
        const filters = [];
        if (gids.length) {
            filters.push({ kinds: [CONFIG.KINDS.GROUP], '#g': gids, since: oldestNeededSince(), limit: 300 });
            filters.push({ kinds: [CONFIG.KINDS.PRESENCE], '#g': gids, since: Math.floor(Date.now() / 1000) - 120 });
        }
        const dmSince = Math.floor(Date.now() / 1000) - 30 * 86400;
        filters.push({ kinds: [CONFIG.KINDS.DM], '#p': [state.myPublicKey], since: dmSince });
        filters.push({ kinds: [CONFIG.KINDS.DM], authors: [state.myPublicKey], since: dmSince });

        SkateNostr.sub('skate-main', filters, handleIncoming, () => {
            if (gen === state.subGeneration) notifyUpdate();
        });
    }

    // ========== INCOMING ==========
    function handleIncoming(event) {
        if (event.kind === CONFIG.KINDS.DM) return handleDm(event);
        const gTag = (event.tags || []).find(t => t[0] === 'g');
        if (!gTag) return;
        const group = getGroupOrRoom(gTag[1]);
        if (!group) return;

        if (event.kind === CONFIG.KINDS.PRESENCE) {
            const plain = Crypto.decryptForGroup(event.content, group.secret);
            if (!plain) return;
            try {
                const c = JSON.parse(plain);
                trackMember(group, c.from, event.pubkey, event.created_at * 1000);
            } catch {}
            notifyUpdate();
            return;
        }

        if (event.kind !== CONFIG.KINDS.GROUP) return;
        const plain = Crypto.decryptForGroup(event.content, group.secret);
        if (!plain) return;
        let c;
        try { c = JSON.parse(plain); } catch { return; }
        const mine = event.pubkey === state.myPublicKey;
        const ts = event.created_at * 1000;
        trackMember(group, c.from, event.pubkey, ts);

        if (c.type === 'vote') {
            applyVote(group, c.programId, event.pubkey, c.from, c.voted);
            saveState();
            notifyUpdate();
            return;
        }

        const msg = {
            id: event.id,
            type: c.type === 'share' ? 'share' : 'chat',
            text: SkateMod.clean(c.text || ''),
            from: c.from, fromPubkey: event.pubkey,
            mine, system: !!c.system, ts,
            data: c.data, status: 'sent'
        };
        const wasNew = addMessage(group, msg);
        if (wasNew && !mine && !c.system && ts > (group.lastReadTs || 0)) {
            if (state.activeGroupId !== group.id) {
                Notify.browser(`${c.from} in ${group.name}`, c.text || '');
            } else {
                group.lastReadTs = ts; // viewing it live: auto-read
            }
        }
        saveState();
        notifyUpdate();
    }

    function addMessage(group, msg) {
        if (group.messages.some(m => m.id === msg.id)) return false;
        // Replace optimistic local echo when the relay copy arrives
        const localIdx = msg.mine ? group.messages.findIndex(m => m.localId && m.text === msg.text && Math.abs(m.ts - msg.ts) < 15000) : -1;
        if (localIdx > -1) { group.messages[localIdx] = msg; return false; }
        group.messages.push(msg);
        group.messages.sort((a, b) => a.ts - b.ts);
        if (group.messages.length > CONFIG.MAX_MESSAGES) group.messages = group.messages.slice(-CONFIG.MAX_MESSAGES);
        return true;
    }

    function trackMember(group, name, pubkey, ts) {
        if (!name) return;
        if (!group.members.includes(name)) group.members.push(name);
        if (!group.memberPubkeys) group.memberPubkeys = {};
        group.memberPubkeys[name] = pubkey;
        if (!group._online) group._online = {};
        group._online[pubkey] = Math.max(group._online[pubkey] || 0, ts);
    }

    function onlineCount(group) {
        const cutoff = Date.now() - CONFIG.ONLINE_WINDOW;
        return Object.values(group._online || {}).filter(t => t > cutoff).length;
    }

    function applyVote(group, programId, pubkey, name, voted) {
        if (!programId) return;
        if (!group.votes) group.votes = {};
        if (!group.votes[programId]) group.votes[programId] = {};
        if (voted) group.votes[programId][pubkey] = name;
        else delete group.votes[programId][pubkey];
    }

    // ========== DMs (group-independent, persistent) ==========
    function handleDm(event) {
        const pTag = (event.tags || []).find(t => t[0] === 'p');
        if (!pTag) return;
        const isFromMe = event.pubkey === state.myPublicKey;
        const isForMe = pTag[1] === state.myPublicKey;
        if (!isForMe && !isFromMe) return;

        const otherPubkey = isFromMe ? pTag[1] : event.pubkey;
        const plain = Crypto.decryptDm(event.content, state.mySecretKey, otherPubkey);
        if (!plain) return;
        let c;
        try { c = JSON.parse(plain); } catch { return; }

        if (!state.dmThreads[otherPubkey]) {
            state.dmThreads[otherPubkey] = { name: isFromMe ? (c.toName || 'Skater') : (c.fromName || 'Skater'), messages: [], lastReadTs: 0 };
        }
        const thread = state.dmThreads[otherPubkey];
        if (!isFromMe && c.fromName) thread.name = c.fromName;
        if (thread.messages.some(m => m.id === event.id)) return;

        const ts = event.created_at * 1000;
        const localIdx = isFromMe ? thread.messages.findIndex(m => m.localId && m.text === c.text && Math.abs(m.ts - ts) < 15000) : -1;
        const msg = { id: event.id, text: SkateMod.clean(c.text || ''), from: isFromMe ? state.myName : thread.name, mine: isFromMe, ts, status: 'sent' };
        if (localIdx > -1) thread.messages[localIdx] = msg;
        else { thread.messages.push(msg); thread.messages.sort((a, b) => a.ts - b.ts); }
        if (thread.messages.length > 100) thread.messages = thread.messages.slice(-100);

        if (!isFromMe && ts > (thread.lastReadTs || 0)) {
            if (state.activeDmRecipient === otherPubkey) thread.lastReadTs = ts;
            else Notify.browser(`DM from ${thread.name}`, c.text || '');
        }
        saveState();
        notifyUpdate();
    }

    // ========== SEND PIPELINE ==========
    async function signAndSend(template, powBits) {
        let tpl = template;
        if (powBits > 0) {
            // minePow hashes the event, so it needs the pubkey up front
            try { tpl = await SkateMod.mine({ ...template, pubkey: state.myPublicKey }, powBits); }
            catch (e) { console.warn('[SkateChat] PoW skipped:', e?.message || e); }
        }
        const event = NostrTools.finalizeEvent(tpl, state.mySecretKey);
        const ok = await SkateNostr.publish(event);
        return { event, ok };
    }

    async function publishToGroup(groupId, payload, powBits = SkateMod.POW.chat) {
        const group = getGroupOrRoom(groupId);
        if (!group || !state.mySecretKey) return { ok: false };
        const template = {
            kind: CONFIG.KINDS.GROUP,
            content: Crypto.encryptForGroup(JSON.stringify(payload), group.secret),
            tags: [['g', groupId]],
            created_at: Math.floor(Date.now() / 1000)
        };
        return signAndSend(template, powBits);
    }

    async function sendMessage(text) {
        const groupId = state.activeGroupId;
        const group = getGroupOrRoom(groupId);
        if (!group || !text.trim()) return false;
        const trimmed = text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);

        const verdict = await SkateMod.check(trimmed);
        if (!verdict.ok) {
            Notify.toast('That message won\'t fly here 🙈 — keep it friendly', 'error', 3000);
            return false;
        }

        // Optimistic local echo with pending state
        const localId = 'local_' + Crypto.randomHex(6);
        const echo = { id: localId, localId, type: 'chat', text: trimmed, from: state.myName, fromPubkey: state.myPublicKey, mine: true, ts: Date.now(), status: 'pending' };
        group.messages.push(echo);
        notifyUpdate();

        const { ok } = await publishToGroup(groupId, { type: 'chat', text: trimmed, from: state.myName });
        const m = group.messages.find(x => x.id === localId);
        if (m) m.status = ok ? 'sent' : 'failed';
        saveState();
        notifyUpdate();
        return ok;
    }

    async function shareProgram(program) {
        if (!state.activeGroupId) return false;
        const activity = program.Activity || program['Activity Title'] || 'Unknown';
        const location = program.LocationName || program['Location Name'] || '';
        const dateStr = program['Start Date Time'] || program['Start Date'] || '';
        let dateDisplay = '';
        if (dateStr) dateDisplay = new Date(dateStr).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
        const { ok } = await publishToGroup(state.activeGroupId, {
            type: 'share', text: `⛸️ ${activity}`, from: state.myName,
            data: { activity, location, date: dateDisplay, time: program['Start Time'] || '', endTime: program['End Time'] || '' }
        });
        if (ok) Notify.toast('Shared to the group 📤', 'success', 2000);
        return ok;
    }

    async function voteTime(program) {
        const group = getGroupOrRoom(state.activeGroupId);
        if (!group) return false;
        const programId = typeof program === 'string' ? program : Favorites.getId(program);
        const votedNow = !(group.votes?.[programId]?.[state.myPublicKey]);
        applyVote(group, programId, state.myPublicKey, state.myName, votedNow);
        saveState();
        notifyUpdate();
        const { ok } = await publishToGroup(state.activeGroupId,
            { type: 'vote', programId, from: state.myName, voted: votedNow }, SkateMod.POW.vote);
        return ok;
    }

    function getVotes(program) {
        const group = getGroupOrRoom(state.activeGroupId);
        const programId = typeof program === 'string' ? program : Favorites.getId(program);
        const bucket = group?.votes?.[programId] || {};
        return { count: Object.keys(bucket).length, mine: !!bucket[state.myPublicKey] };
    }

    async function sendDm(text) {
        const to = state.activeDmRecipient;
        const thread = state.dmThreads[to];
        if (!to || !thread || !text.trim()) return false;
        const trimmed = text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);

        const verdict = await SkateMod.check(trimmed);
        if (!verdict.ok) {
            Notify.toast('That message won\'t fly here 🙈', 'error', 3000);
            return false;
        }

        const localId = 'local_' + Crypto.randomHex(6);
        thread.messages.push({ id: localId, localId, text: trimmed, from: state.myName, mine: true, ts: Date.now(), status: 'pending' });
        notifyUpdate();

        const template = {
            kind: CONFIG.KINDS.DM,
            content: Crypto.encryptDm(JSON.stringify({ text: trimmed, fromName: state.myName, toName: thread.name }), state.mySecretKey, to),
            tags: [['p', to]],
            created_at: Math.floor(Date.now() / 1000)
        };
        const { ok } = await signAndSend(template, SkateMod.POW.chat);
        const m = thread.messages.find(x => x.id === localId);
        if (m) m.status = ok ? 'sent' : 'failed';
        saveState();
        notifyUpdate();
        return ok;
    }

    // ========== PRESENCE (ephemeral by design) ==========
    function startPresence() {
        stopPresence();
        const beat = () => {
            allGroupIds().forEach(gid => {
                const group = getGroupOrRoom(gid);
                if (!group) return;
                try {
                    const event = NostrTools.finalizeEvent({
                        kind: CONFIG.KINDS.PRESENCE,
                        content: Crypto.encryptForGroup(JSON.stringify({ from: state.myName }), group.secret),
                        tags: [['g', gid]],
                        created_at: Math.floor(Date.now() / 1000)
                    }, state.mySecretKey);
                    SkateNostr.publish(event, 3000);
                } catch {}
            });
        };
        beat();
        state.presenceTimer = setInterval(beat, CONFIG.PRESENCE_INTERVAL);
    }
    function stopPresence() {
        if (state.presenceTimer) { clearInterval(state.presenceTimer); state.presenceTimer = null; }
    }

    // ========== GROUP MANAGEMENT ==========
    function makeGroup(id, name, secret, extra = {}) {
        return {
            id, name, secret, members: [state.myName],
            memberPubkeys: { [state.myName]: state.myPublicKey },
            messages: [], votes: {}, connected: false,
            lastReadTs: Date.now(), createdAt: Date.now(),
            _online: { [state.myPublicKey]: Date.now() },
            ...extra
        };
    }

    async function joinPublicRoom(roomKey) {
        const room = PUBLIC_ROOMS[roomKey];
        if (!room) throw new Error('Unknown room');
        if (!state.publicRoomSecrets[roomKey]) state.publicRoomSecrets[roomKey] = await Crypto.sha256(room.passphrase);
        const secret = state.publicRoomSecrets[roomKey];
        const groupId = Crypto.deriveGroupId(secret);

        if (!state.publicRooms[groupId]) {
            state.publicRooms[groupId] = makeGroup(groupId, room.name, secret, { isPublic: true, roomKey, emoji: room.emoji });
            resubscribe();
            Notify.toast(`Joined ${room.name}! ⛸️`, 'success');
        }
        state.activeGroupId = groupId;
        state.activeIsPublic = true;
        state.publicRooms[groupId].lastReadTs = Date.now();
        saveState(true);
        notifyUpdate();
        return { groupId };
    }

    async function createGroup(options = {}) {
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) throw new Error(`Max ${CONFIG.MAX_GROUPS} private groups`);
        const name = (options.name || 'Skating Group').trim().slice(0, 40);
        if (SkateMod.checkLocal(name)) throw new Error('Group name contains inappropriate content');
        const secret = options.password ? await Crypto.sha256(options.password) : Crypto.randomHex(32);
        const groupId = Crypto.deriveGroupId(secret);
        if (!state.groups[groupId]) {
            state.groups[groupId] = makeGroup(groupId, name, secret, { hasPassword: !!options.password });
            resubscribe();
            publishToGroup(groupId, { type: 'chat', text: `${state.myName} created the group`, from: state.myName, system: true }, 0);
        }
        state.activeGroupId = groupId;
        state.activeIsPublic = false;
        saveState(true);
        notifyUpdate();
        return { groupId, shareUrl: getShareUrl() };
    }

    async function joinGroup(secret, password = null, customName = null) {
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) throw new Error(`Max ${CONFIG.MAX_GROUPS} private groups`);
        let actualSecret;
        if (password) actualSecret = await Crypto.sha256(password);
        else if (secret.length === 64 && /^[0-9a-f]+$/i.test(secret)) actualSecret = secret.toLowerCase();
        else actualSecret = await Crypto.sha256(secret);

        const groupId = Crypto.deriveGroupId(actualSecret);
        if (!state.groups[groupId]) {
            state.groups[groupId] = makeGroup(groupId, customName || 'Skating Group', actualSecret, { hasPassword: !!password });
            resubscribe();
            publishToGroup(groupId, { type: 'chat', text: `${state.myName} joined the group`, from: state.myName, system: true }, 0);
            Notify.toast('Joined the group! 🎉', 'success');
        }
        state.activeGroupId = groupId;
        state.activeIsPublic = false;
        saveState(true);
        notifyUpdate();
        return { groupId };
    }

    function leaveGroup(groupId) {
        const isPublic = !!state.publicRooms[groupId];
        const group = isPublic ? state.publicRooms[groupId] : state.groups[groupId];
        if (!group) return;
        if (!isPublic) publishToGroup(groupId, { type: 'chat', text: `${state.myName} left the group`, from: state.myName, system: true }, 0);
        if (isPublic) delete state.publicRooms[groupId];
        else delete state.groups[groupId];
        if (state.activeGroupId === groupId) {
            const next = Object.keys(state.groups)[0] || Object.keys(state.publicRooms)[0] || null;
            state.activeGroupId = next;
            state.activeIsPublic = next ? !!state.publicRooms[next] : false;
        }
        resubscribe();
        saveState(true);
        notifyUpdate();
    }

    function switchGroup(groupId) {
        const group = getGroupOrRoom(groupId);
        if (!group) return;
        state.activeGroupId = groupId;
        state.activeIsPublic = !!state.publicRooms[groupId];
        state.activeDmRecipient = null;
        group.lastReadTs = Date.now();
        saveState();
        notifyUpdate();
    }

    // ========== DM SURFACE ==========
    function startDm(nameOrPubkey) {
        let pubkey = null, name = null;
        if (/^[0-9a-f]{64}$/i.test(nameOrPubkey)) {
            pubkey = nameOrPubkey;
            name = state.dmThreads[pubkey]?.name || 'Skater';
        } else {
            const group = getGroupOrRoom(state.activeGroupId);
            pubkey = group?.memberPubkeys?.[nameOrPubkey] || null;
            name = nameOrPubkey;
        }
        if (!pubkey || pubkey === state.myPublicKey) return false;
        if (!state.dmThreads[pubkey]) state.dmThreads[pubkey] = { name, messages: [], lastReadTs: 0 };
        state.dmThreads[pubkey].lastReadTs = Date.now();
        state.activeDmRecipient = pubkey;
        saveState();
        notifyUpdate();
        return true;
    }

    function closeDm() { state.activeDmRecipient = null; notifyUpdate(); }

    function getDmThreadsList() {
        return Object.entries(state.dmThreads).map(([pubkey, t]) => {
            const last = t.messages[t.messages.length - 1] || null;
            const unread = t.messages.filter(m => !m.mine && m.ts > (t.lastReadTs || 0)).length;
            return { pubkey, name: t.name, unread, lastMessage: last };
        }).sort((a, b) => (b.lastMessage?.ts || 0) - (a.lastMessage?.ts || 0));
    }

    // ========== PUBLIC SURFACE ==========
    async function init() {
        if (typeof NostrTools === 'undefined') { console.error('[SkateChat] NostrTools not loaded'); return; }
        loadState();
        initIdentity();
        Favorites.load();

        for (const [key, room] of Object.entries(PUBLIC_ROOMS)) {
            if (!state.publicRoomSecrets[key]) state.publicRoomSecrets[key] = await Crypto.sha256(room.passphrase);
        }

        SkateNostr.onStatus(({ connected }) => {
            const online = connected > 0;
            [...Object.values(state.groups), ...Object.values(state.publicRooms)].forEach(g => { g.connected = online; });
            notifyUpdate();
        });
        SkateNostr.start();

        const hash = window.location.hash.slice(1);
        if (hash && hash.length >= 32 && /^[0-9a-f]+$/i.test(hash)) {
            const groupId = Crypto.deriveGroupId(hash.toLowerCase());
            if (!state.groups[groupId]) await joinGroup(hash);
            else { state.activeGroupId = groupId; state.activeIsPublic = false; }
        }

        resubscribe();
        startPresence();
        notifyUpdate();
    }

    function onUpdate(cb) { state.callbacks.push(cb); cb(getState()); }

    function getState() {
        const activeGroup = state.activeIsPublic ? state.publicRooms[state.activeGroupId] : state.groups[state.activeGroupId] || null;
        const activeDmThread = state.activeDmRecipient ? state.dmThreads[state.activeDmRecipient] : null;

        const unreadOf = g => g.messages.filter(m => !m.mine && !m.system && m.ts > (g.lastReadTs || 0)).length;
        let totalGroupUnread = 0;
        const perGroupUnread = {};
        [...Object.values(state.groups), ...Object.values(state.publicRooms)].forEach(g => {
            const u = unreadOf(g);
            perGroupUnread[g.id] = u;
            totalGroupUnread += u;
        });
        let totalDmUnread = 0;
        Object.values(state.dmThreads).forEach(t => {
            totalDmUnread += t.messages.filter(m => !m.mine && m.ts > (t.lastReadTs || 0)).length;
        });
        Notify.updateTitle(totalDmUnread + totalGroupUnread);

        return {
            myName: state.myName, myPublicKey: state.myPublicKey,
            groups: { ...state.groups, ...state.publicRooms },
            privateGroups: state.groups, publicRooms: state.publicRooms,
            activeGroupId: state.activeGroupId, activeIsPublic: state.activeIsPublic,
            activeGroup, dmThreads: state.dmThreads,
            activeDmRecipient: state.activeDmRecipient, activeDmThread,
            totalDmUnread, totalGroupUnread, perGroupUnread,
            onlineCounts: Object.fromEntries(allGroupIds().map(id => [id, onlineCount(getGroupOrRoom(id))])),
            viewMode: state.activeDmRecipient ? 'dm' : 'group',
            favoritesCount: state.favorites.size,
            publicRoomSecrets: state.publicRoomSecrets
        };
    }

    function getShareUrl() {
        const group = state.groups[state.activeGroupId];
        return group ? `${window.location.origin}${window.location.pathname}#${group.secret}` : null;
    }

    function getConnectionStatus() {
        return SkateNostr.connectedCount() > 0 ? 'connected' : 'disconnected';
    }

    function getPublicRooms() { return PUBLIC_ROOMS; }

    function getIdentity() { return { sk: state.mySecretKey, pk: state.myPublicKey, name: state.myName }; }

    return {
        init, createGroup, joinGroup, joinPublicRoom, leaveGroup, switchGroup,
        sendMessage, shareProgram, voteTime, getVotes,
        startDm, sendDm, closeDm, getDmThreadsList, setDisplayName, getIdentity,
        onUpdate, getState, getShareUrl, getConnectionStatus, getPublicRooms,
        Notify, Favorites, Crypto
    };
})();

if (typeof module !== 'undefined') module.exports = SkateChat;
