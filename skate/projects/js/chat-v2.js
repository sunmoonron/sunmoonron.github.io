/**
 * SkateChat v3 — same relay plumbing as v2, reworked group/DM surface.
 *
 * v3 bug ledger (what changed vs v2 and why):
 *  1. SECURITY — same-password collision. v2 derived the group secret as
 *     sha256(password), so two strangers who both picked "hunter2" landed in
 *     the SAME global group. v3: the secret is ALWAYS random; a password is a
 *     gate on the invite link (secret travels nip44-encrypted under a
 *     password-derived key). Link alone is no longer enough for pw groups.
 *  2. Invites no longer auto-join. init() only *parses* the hash; the app
 *     shows a confirm modal (with the group name, carried in the link) and
 *     calls acceptInvite(). Fixes silent autojoin + password bypass.
 *  3. Presence gets a goodbye. leaveGroup()/pagehide publish {s:'bye'} so the
 *     "2 online" ghost disappears immediately instead of after 90s.
 *  4. Roster keyed by PUBKEY (not display name). v2 keyed memberPubkeys by
 *     name, so two "Skater"s collided and the members list grew forever.
 *  5. Personal mutes (client-side, per pubkey): hides their group messages,
 *     silences their DMs, excluded from unread counts.
 *  6. Replies: messages can carry replyTo {id, from, text-excerpt}; excerpt is
 *     embedded so the quote renders even if the original was evicted.
 *  7. Rename for private groups: broadcast {type:'rename'}, last-writer-wins
 *     by event timestamp (renamedAt guard) + a system line.
 *  8. Share picker: shareProgram/shareGuide take an explicit destination
 *     (any group OR any DM thread) instead of blind-posting to activeGroup.
 *  9. Failed sends are retryable: optimistic echoes keep their payload;
 *     retryMessage() refreshes ts and republishes.
 * 10. Moderation privacy: DMs + private groups are checked LOCALLY only —
 *     v2 shipped private-message plaintext to third-party profanity APIs.
 * 11. Date fix: shareProgram used `new Date('YYYY-MM-DD')` (UTC) → programs
 *     shared as the wrong day in Toronto. Uses local-date parsing now.
 * 12. Storage bumped to v8 with an in-place migration from v7.
 */
const SkateChat = (() => {
    'use strict';

    const CONFIG = {
        KINDS: { GROUP: 42, DM: 4, PRESENCE: 20104 },
        MAX_GROUPS: 10,
        MAX_MESSAGES: 200,
        MAX_MESSAGE_LENGTH: 500,
        STORAGE_KEY: 'skate_chat_v8',
        LEGACY_STORAGE_KEY: 'skate_chat_v7',
        IDENTITY_KEY: 'skate_identity_v1',
        FAVORITES_KEY: 'skate_favorites_v2',
        MUTED_KEY: 'skate_muted_v1',
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
        groups: {},          // private groups: id -> group
        publicRooms: {},     // joined public rooms: id -> group
        activeGroupId: null, activeIsPublic: false,
        dmThreads: {},       // pubkey -> { name, messages[], lastReadTs }
        activeDmRecipient: null,
        callbacks: [],
        presenceTimer: null,
        favorites: new Set(),
        muted: new Set(),    // pubkeys muted by ME (local only)
        publicRoomSecrets: {},
        subGeneration: 0
    };

    // ========== NOTIFICATIONS ==========
    const Notify = {
        permission() { return ('Notification' in window) ? Notification.permission : 'unsupported'; },
        async requestPermission() {
            if (!('Notification' in window)) return 'unsupported';
            try { return await Notification.requestPermission(); } catch { return Notification.permission; }
        },
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
            el.innerHTML = `<span></span><button aria-label="Dismiss">✕</button>`;
            el.querySelector('span').textContent = message;
            el.querySelector('button').onclick = () => el.remove();
            container.appendChild(el);
            setTimeout(() => el.classList.add('show'), 10);
            setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, duration);
        },
        _createContainer() {
            const c = document.createElement('div');
            c.id = 'toast-container';
            c.setAttribute('role', 'status');       // screen readers announce toasts
            c.setAttribute('aria-live', 'polite');
            document.body.appendChild(c);
            return c;
        },
        updateTitle(unread) {
            document.title = unread > 0 ? `(${unread}) Toronto Skating` : 'Toronto Skating';
        }
    };

    // ========== FAVORITES (unchanged) ==========
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

    // ========== MUTES (mine, local-only) ==========
    const Mutes = {
        load() {
            try {
                const saved = localStorage.getItem(CONFIG.MUTED_KEY);
                if (saved) state.muted = new Set(JSON.parse(saved));
            } catch {}
        },
        save() {
            try { localStorage.setItem(CONFIG.MUTED_KEY, JSON.stringify([...state.muted])); } catch {}
        },
        has(pubkey) { return !!pubkey && state.muted.has(pubkey); },
        toggle(pubkey, name = null) {
            if (!pubkey || pubkey === state.myPublicKey) return false;
            if (state.muted.has(pubkey)) {
                state.muted.delete(pubkey);
                Notify.toast(`Unmuted ${name || 'user'} 🔊`, 'success', 2000);
            } else {
                state.muted.add(pubkey);
                Notify.toast(`Muted ${name || 'user'} — their messages are hidden for you 🔇`, 'info', 3000);
            }
            this.save();
            notifyUpdate();
            return state.muted.has(pubkey);
        },
        /** [{pubkey, name}] with best-known display names for the settings list. */
        list() {
            return [...state.muted].map(pk => ({ pubkey: pk, name: lookupName(pk) || 'Skater' }));
        },
        count() { return state.muted.size; }
    };

    function lookupName(pubkey) {
        if (state.dmThreads[pubkey]?.name) return state.dmThreads[pubkey].name;
        for (const g of [...Object.values(state.groups), ...Object.values(state.publicRooms)]) {
            if (g.roster?.[pubkey]?.name) return g.roster[pubkey].name;
        }
        return null;
    }

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
        groupKey(secretHex) {
            const sk = this.hexToBytes(secretHex.slice(0, 64));
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

    // base64url for carrying group names inside invite links
    function b64u(s) {
        try { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
        catch { return ''; }
    }
    function unb64u(s) {
        try { return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))); }
        catch { return null; }
    }

    // ========== IDENTITY ==========
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
        // strip control chars so a name can't smuggle weird glyphs into other clients
        const clean = (name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
        if (!clean || SkateMod.checkLocal(clean)) return false;
        state.myName = clean;
        saveIdentity();
        window.SkateSettings?.set('displayName', clean);
        notifyUpdate();
        return true;
    }

    // ========== PERSISTENCE (debounced) + v7 → v8 MIGRATION ==========
    let saveTimer = null;
    function saveState(immediate = false) {
        if (saveTimer) clearTimeout(saveTimer);
        const write = () => {
            saveTimer = null;
            try {
                const slim = (groups) => {
                    const out = {};
                    for (const [id, g] of Object.entries(groups)) {
                        const { _online, ...rest } = g;
                        out[id] = { ...rest, messages: g.messages.slice(-CONFIG.MAX_MESSAGES) };
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

    function migrateGroupShape(g) {
        // v7 kept members:[names] + memberPubkeys:{name→pk}; v8 keeps roster:{pk→{name,last}}
        if (!g.roster) {
            g.roster = {};
            const pkByName = g.memberPubkeys || {};
            for (const [name, pk] of Object.entries(pkByName)) {
                if (/^[0-9a-f]{64}$/i.test(pk)) g.roster[pk] = { name, last: 0 };
            }
            (g.messages || []).forEach(m => {
                if (m.fromPubkey && /^[0-9a-f]{64}$/i.test(m.fromPubkey) && !m.system) {
                    if (!g.roster[m.fromPubkey]) g.roster[m.fromPubkey] = { name: m.from || 'Skater', last: 0 };
                }
            });
        }
        delete g.members;
        delete g.memberPubkeys;
        if (!g.messages) g.messages = [];
        if (!g.votes) g.votes = {};
        g.connected = false;
        return g;
    }

    function loadState() {
        try {
            let saved = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (!saved) saved = localStorage.getItem(CONFIG.LEGACY_STORAGE_KEY); // migrate v7 in place
            if (!saved) return;
            const p = JSON.parse(saved);
            state.groups = p.groups || {};
            state.publicRooms = p.publicRooms || {};
            state.publicRoomSecrets = p.publicRoomSecrets || {};
            state.dmThreads = p.dmThreads || {};
            state.activeGroupId = p.activeGroupId || null;
            state.activeIsPublic = p.activeIsPublic || false;
            Object.values(state.groups).concat(Object.values(state.publicRooms)).forEach(migrateGroupShape);
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
    function sanitizeReplyRef(r) {
        if (!r || typeof r !== 'object') return null;
        const out = {
            from: String(r.from || '').slice(0, 24),
            text: String(r.text || '').slice(0, 120)
        };
        if (typeof r.id === 'string' && /^[0-9a-f_]{1,64}$/i.test(r.id)) out.id = r.id;
        return out.text || out.from ? out : null;
    }

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
                if (c.s === 'bye') {
                    // explicit goodbye: drop them from the online window immediately
                    if (group.roster?.[event.pubkey]) group.roster[event.pubkey].last = 0;
                } else {
                    trackMember(group, c.from, event.pubkey, event.created_at * 1000);
                }
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

        if (c.type === 'rename') {
            // last-writer-wins by relay timestamp; block muted users from renaming your view
            const newName = SkateMod.clean(String(c.name || '')).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
            if (newName && ts >= (group.renamedAt || 0) && !Mutes.has(event.pubkey)) {
                group.renamedAt = ts;
                if (group.name !== newName) {
                    group.name = newName;
                    addMessage(group, {
                        id: event.id, type: 'chat', system: true, mine,
                        text: `${c.from || 'Someone'} renamed the group to “${newName}”`,
                        from: c.from, fromPubkey: event.pubkey, ts, status: 'sent'
                    });
                }
                saveState();
                notifyUpdate();
            }
            return;
        }

        const msg = {
            id: event.id,
            type: c.type === 'share' ? 'share' : (c.type === 'guide' ? 'guide' : 'chat'),
            text: SkateMod.clean(c.text || ''),
            from: c.from, fromPubkey: event.pubkey,
            mine, system: !!c.system, ts,
            data: c.data, replyTo: sanitizeReplyRef(c.replyTo), status: 'sent'
        };
        const wasNew = addMessage(group, msg);
        if (wasNew && !mine && !c.system && ts > (group.lastReadTs || 0)) {
            if (state.activeGroupId !== group.id) {
                if (!Mutes.has(event.pubkey)) Notify.browser(`${c.from} in ${group.name}`, c.text || '');
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
        if (!pubkey) return;
        if (!group.roster) group.roster = {};
        const entry = group.roster[pubkey] || { name: 'Skater', last: 0 };
        if (name) entry.name = String(name).slice(0, 24);
        entry.last = Math.max(entry.last || 0, ts);
        group.roster[pubkey] = entry;
    }

    function onlineCount(group) {
        const cutoff = Date.now() - CONFIG.ONLINE_WINDOW;
        return Object.values(group.roster || {}).filter(m => (m.last || 0) > cutoff).length;
    }

    /** Members of a group, online first, me excluded (UI shows "you" separately). */
    function getRoster(groupId) {
        const group = getGroupOrRoom(groupId);
        if (!group?.roster) return [];
        const cutoff = Date.now() - CONFIG.ONLINE_WINDOW;
        return Object.entries(group.roster)
            .filter(([pk]) => pk !== state.myPublicKey)
            .map(([pubkey, m]) => ({ pubkey, name: m.name || 'Skater', online: (m.last || 0) > cutoff, last: m.last || 0, muted: Mutes.has(pubkey) }))
            .sort((a, b) => (b.online - a.online) || (b.last - a.last));
    }

    function applyVote(group, programId, pubkey, name, voted) {
        if (!programId) return;
        if (!group.votes) group.votes = {};
        if (!group.votes[programId]) group.votes[programId] = {};
        if (voted) group.votes[programId][pubkey] = name;
        else delete group.votes[programId][pubkey];
    }

    // ========== DMs ==========
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
        if (!isFromMe && c.fromName) thread.name = String(c.fromName).slice(0, 24);
        if (thread.messages.some(m => m.id === event.id)) return;

        const ts = event.created_at * 1000;
        const localIdx = isFromMe ? thread.messages.findIndex(m => m.localId && m.text === c.text && Math.abs(m.ts - ts) < 15000) : -1;
        const msg = {
            id: event.id,
            type: c.type === 'share' ? 'share' : (c.type === 'guide' ? 'guide' : 'chat'),
            text: SkateMod.clean(c.text || ''),
            from: isFromMe ? state.myName : thread.name,
            mine: isFromMe, ts, data: c.data, replyTo: sanitizeReplyRef(c.replyTo), status: 'sent'
        };
        if (localIdx > -1) thread.messages[localIdx] = msg;
        else { thread.messages.push(msg); thread.messages.sort((a, b) => a.ts - b.ts); }
        if (thread.messages.length > 100) thread.messages = thread.messages.slice(-100);

        if (!isFromMe && ts > (thread.lastReadTs || 0)) {
            if (state.activeDmRecipient === otherPubkey) thread.lastReadTs = ts;
            else if (!Mutes.has(otherPubkey)) Notify.browser(`DM from ${thread.name}`, c.text || '');
        }
        saveState();
        notifyUpdate();
    }

    // ========== SEND PIPELINE ==========
    async function signAndSend(template, powBits) {
        let tpl = template;
        if (powBits > 0) {
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

    async function publishDm(toPubkey, payload) {
        const template = {
            kind: CONFIG.KINDS.DM,
            content: Crypto.encryptDm(JSON.stringify(payload), state.mySecretKey, toPubkey),
            tags: [['p', toPubkey]],
            created_at: Math.floor(Date.now() / 1000)
        };
        return signAndSend(template, SkateMod.POW.chat);
    }

    /** Moderation context: public rooms get the remote APIs; private stays on-device. */
    function moderationOpts(groupOrNullForDm) {
        const isPublic = !!groupOrNullForDm?.isPublic;
        return { remote: isPublic };
    }

    async function sendMessage(text, replyTo = null) {
        const groupId = state.activeGroupId;
        const group = getGroupOrRoom(groupId);
        if (!group || !text.trim()) return false;
        const trimmed = text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);

        const verdict = await SkateMod.check(trimmed, moderationOpts(group));
        if (!verdict.ok) {
            Notify.toast('That message won\'t fly here 🙈 — keep it friendly', 'error', 3000);
            return false;
        }

        const payload = { type: 'chat', text: trimmed, from: state.myName };
        if (replyTo) payload.replyTo = sanitizeReplyRef(replyTo);

        const localId = 'local_' + Crypto.randomHex(6);
        const echo = { id: localId, localId, type: 'chat', text: trimmed, from: state.myName, fromPubkey: state.myPublicKey, mine: true, ts: Date.now(), replyTo: payload.replyTo || null, status: 'pending', payload };
        group.messages.push(echo);
        notifyUpdate();

        const { ok } = await publishToGroup(groupId, payload);
        const m = group.messages.find(x => x.id === localId);
        if (m) m.status = ok ? 'sent' : 'failed';
        saveState();
        notifyUpdate();
        return ok;
    }

    async function sendDm(text, replyTo = null) {
        const to = state.activeDmRecipient;
        const thread = state.dmThreads[to];
        if (!to || !thread || !text.trim()) return false;
        const trimmed = text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);

        const verdict = await SkateMod.check(trimmed, { remote: false }); // DMs never leave the device for moderation
        if (!verdict.ok) {
            Notify.toast('That message won\'t fly here 🙈', 'error', 3000);
            return false;
        }

        const payload = { type: 'chat', text: trimmed, fromName: state.myName, toName: thread.name };
        if (replyTo) payload.replyTo = sanitizeReplyRef(replyTo);

        const localId = 'local_' + Crypto.randomHex(6);
        thread.messages.push({ id: localId, localId, type: 'chat', text: trimmed, from: state.myName, mine: true, ts: Date.now(), replyTo: payload.replyTo || null, status: 'pending', payload });
        notifyUpdate();

        const { ok } = await publishDm(to, payload);
        const m = thread.messages.find(x => x.id === localId);
        if (m) m.status = ok ? 'sent' : 'failed';
        saveState();
        notifyUpdate();
        return ok;
    }

    /** Retry a failed optimistic message (group or DM). */
    async function retryMessage(kind, convId, localId) {
        const list = kind === 'dm' ? state.dmThreads[convId]?.messages : getGroupOrRoom(convId)?.messages;
        const m = list?.find(x => x.localId === localId && x.status === 'failed');
        if (!m || !m.payload) return false;
        m.status = 'pending';
        m.ts = Date.now(); // refresh the echo-replacement window
        notifyUpdate();
        const { ok } = kind === 'dm' ? await publishDm(convId, m.payload) : await publishToGroup(convId, m.payload);
        m.status = ok ? 'sent' : 'failed';
        saveState();
        notifyUpdate();
        return ok;
    }

    // ---- Sharing: explicit destination (group OR dm) ----
    function programCard(program) {
        const activity = program.Activity || program['Activity Title'] || 'Unknown';
        const location = program.LocationName || program['Location Name'] || '';
        const dateStr = program['Start Date Time'] || program['Start Date'] || '';
        let dateDisplay = '';
        if (dateStr) {
            // parse as LOCAL date — `new Date('YYYY-MM-DD')` is UTC and shifted the day
            const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
            const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(dateStr);
            dateDisplay = d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
        }
        return {
            activity, location, date: dateDisplay,
            time: program['Start Time'] || '', endTime: program['End Time'] || '',
            programId: Favorites.getId(program)
        };
    }

    async function shareTo(dest, payload) {
        if (dest.kind === 'dm') {
            const thread = state.dmThreads[dest.id] || (state.dmThreads[dest.id] = { name: dest.name || lookupName(dest.id) || 'Skater', messages: [], lastReadTs: 0 });
            const localId = 'local_' + Crypto.randomHex(6);
            const dmPayload = { ...payload, fromName: state.myName, toName: thread.name };
            thread.messages.push({ id: localId, localId, type: payload.type, text: payload.text, from: state.myName, mine: true, ts: Date.now(), data: payload.data, status: 'pending', payload: dmPayload });
            notifyUpdate();
            const { ok } = await publishDm(dest.id, dmPayload);
            const m = thread.messages.find(x => x.id === localId);
            if (m) m.status = ok ? 'sent' : 'failed';
            saveState(); notifyUpdate();
            return ok;
        }
        const { ok } = await publishToGroup(dest.id, { ...payload, from: state.myName });
        return ok;
    }

    async function shareProgram(program, dest) {
        const data = programCard(program);
        const target = dest || (state.activeGroupId ? { kind: 'group', id: state.activeGroupId } : null);
        if (!target) return false;
        const ok = await shareTo(target, { type: 'share', text: `⛸️ ${data.activity}`, data });
        if (ok) Notify.toast(`Shared to ${target.name || 'the chat'} 📤`, 'success', 2000);
        else Notify.toast('Share didn\'t reach the relays — try again', 'error');
        return ok;
    }

    async function shareGuide(guideRef, dest) {
        // guideRef: {guideId, title, category, excerpt?}
        if (!dest) return false;
        const data = {
            guideId: String(guideRef.guideId || '').slice(0, 64),
            title: String(guideRef.title || '').slice(0, 80),
            category: String(guideRef.category || '').slice(0, 20),
            excerpt: String(guideRef.excerpt || '').slice(0, 200)
        };
        const ok = await shareTo(dest, { type: 'guide', text: `📖 ${data.title}`, data });
        if (ok) Notify.toast(`Guide shared to ${dest.name || 'the chat'} 📖`, 'success', 2000);
        else Notify.toast('Share didn\'t reach the relays — try again', 'error');
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

    // ========== PRESENCE ==========
    function presenceEvent(group, gid, status) {
        return NostrTools.finalizeEvent({
            kind: CONFIG.KINDS.PRESENCE,
            content: Crypto.encryptForGroup(JSON.stringify({ from: state.myName, s: status }), group.secret),
            tags: [['g', gid]],
            created_at: Math.floor(Date.now() / 1000)
        }, state.mySecretKey);
    }

    function startPresence() {
        stopPresence();
        const beat = () => {
            allGroupIds().forEach(gid => {
                const group = getGroupOrRoom(gid);
                if (!group) return;
                try { SkateNostr.publish(presenceEvent(group, gid, 'on'), 3000); } catch {}
            });
        };
        beat();
        state.presenceTimer = setInterval(beat, CONFIG.PRESENCE_INTERVAL);
    }
    function stopPresence() {
        if (state.presenceTimer) { clearInterval(state.presenceTimer); state.presenceTimer = null; }
    }

    function sendBye(groupIds) {
        groupIds.forEach(gid => {
            const group = getGroupOrRoom(gid);
            if (!group) return;
            try { SkateNostr.publish(presenceEvent(group, gid, 'bye'), 800); } catch {}
        });
    }

    // ========== GROUP MANAGEMENT ==========
    function makeGroup(id, name, secret, extra = {}) {
        return {
            id, name, secret,
            roster: { [state.myPublicKey]: { name: state.myName, last: Date.now() } },
            messages: [], votes: {}, connected: false,
            lastReadTs: Date.now(), createdAt: Date.now(),
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

    /**
     * Create a private group.
     * The secret is ALWAYS random (fixes the same-password global-collision bug).
     * If a password is set, the invite link carries the secret nip44-encrypted
     * under a key derived from the password — link alone won't get anyone in.
     */
    async function createGroup(options = {}) {
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) throw new Error(`Max ${CONFIG.MAX_GROUPS} private groups`);
        const name = (options.name || 'Skating Group').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
        if (SkateMod.checkLocal(name)) throw new Error('Group name contains inappropriate content');

        const secret = Crypto.randomHex(32);
        const groupId = Crypto.deriveGroupId(secret);
        const extra = { hasPassword: false };

        if (options.password) {
            const pwKeyHex = await Crypto.sha256(options.password);
            extra.hasPassword = true;
            extra.inviteEnc = NostrTools.nip44.encrypt(secret, Crypto.groupKey(pwKeyHex));
        }

        state.groups[groupId] = makeGroup(groupId, name, secret, extra);
        resubscribe();
        publishToGroup(groupId, { type: 'chat', text: `${state.myName} created the group`, from: state.myName, system: true }, 0);
        state.activeGroupId = groupId;
        state.activeIsPublic = false;
        saveState(true);
        notifyUpdate();
        return { groupId, invite: getInviteInfo(groupId) };
    }

    function joinBySecret(secret, name = null, extra = {}) {
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) throw new Error(`Max ${CONFIG.MAX_GROUPS} private groups`);
        const groupId = Crypto.deriveGroupId(secret);
        if (!state.groups[groupId]) {
            state.groups[groupId] = makeGroup(groupId, name || 'Skating Group', secret, extra);
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

    // ---- Invite links ----
    // open:      #i=<secret>.<b64name>
    // password:  #j=<groupId>.<b64(nip44enc(secret))>.<b64name>
    // legacy v2: #<hex-secret>  (still accepted, treated as open)
    function getInviteInfo(groupId) {
        const group = state.groups[groupId];
        if (!group) return null;
        const base = `${window.location.origin}${window.location.pathname}`;
        if (group.hasPassword && group.inviteEnc) {
            return { url: `${base}#j=${group.id}.${b64u(group.inviteEnc)}.${b64u(group.name)}`, hasPassword: true };
        }
        return { url: `${base}#i=${group.secret}.${b64u(group.name)}`, hasPassword: false };
    }

    function parseInviteHash(rawHash) {
        const hash = (rawHash || '').replace(/^#/, '');
        if (!hash) return null;
        if (hash.startsWith('i=')) {
            const [secret, nameB64] = hash.slice(2).split('.');
            if (!secret || !/^[0-9a-f]{32,64}$/i.test(secret)) return null;
            return { mode: 'open', secret: secret.toLowerCase(), name: nameB64 ? unb64u(nameB64) : null };
        }
        if (hash.startsWith('j=')) {
            const [groupId, encB64, nameB64] = hash.slice(2).split('.');
            const enc = encB64 ? unb64u(encB64) : null;
            if (!groupId || !enc) return null;
            return { mode: 'password', groupId, enc, name: nameB64 ? unb64u(nameB64) : null };
        }
        if (hash.length >= 32 && /^[0-9a-f]+$/i.test(hash)) {
            // legacy v2 link: the whole hash is (or hashes to) the secret
            return { mode: 'legacy', raw: hash.toLowerCase(), name: null };
        }
        return null;
    }

    async function acceptInvite(invite, password = null) {
        if (invite.mode === 'open') {
            return joinBySecret(invite.secret, invite.name);
        }
        if (invite.mode === 'legacy') {
            const secret = invite.raw.length === 64 ? invite.raw : await Crypto.sha256(invite.raw);
            return joinBySecret(secret, invite.name);
        }
        if (invite.mode === 'password') {
            if (!password) throw new Error('This group needs a password');
            const pwKeyHex = await Crypto.sha256(password);
            let secret = null;
            try { secret = NostrTools.nip44.decrypt(invite.enc, Crypto.groupKey(pwKeyHex)); } catch {}
            if (!secret || Crypto.deriveGroupId(secret) !== invite.groupId) throw new Error('Wrong password for this group');
            return joinBySecret(secret, invite.name, { hasPassword: true, inviteEnc: invite.enc });
        }
        throw new Error('Invalid invite link');
    }

    async function renameGroup(groupId, newName) {
        const group = state.groups[groupId];
        if (!group) throw new Error('Only private groups can be renamed');
        const name = (newName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
        if (!name) throw new Error('Give the group a name');
        if (SkateMod.checkLocal(name)) throw new Error('That name won\'t fly here');
        group.name = name;
        group.renamedAt = Date.now();
        saveState(true);
        notifyUpdate();
        const { ok } = await publishToGroup(groupId, { type: 'rename', name, from: state.myName }, 0);
        if (!ok) Notify.toast('Renamed locally — relays didn\'t confirm, others may not see it yet', 'info', 3500);
        return ok;
    }

    function leaveGroup(groupId) {
        const isPublic = !!state.publicRooms[groupId];
        const group = isPublic ? state.publicRooms[groupId] : state.groups[groupId];
        if (!group) return;
        sendBye([groupId]); // clear the "still online" ghost for everyone else
        if (!isPublic) publishToGroup(groupId, { type: 'chat', text: `${state.myName} left the group`, from: state.myName, system: true }, 0);
        if (isPublic) delete state.publicRooms[groupId];
        else delete state.groups[groupId];
        if (state.activeGroupId === groupId) {
            state.activeGroupId = null;
            state.activeIsPublic = false;
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

    function clearHistory(kind, id) {
        if (kind === 'dm') {
            const t = state.dmThreads[id];
            if (t) { t.messages = []; t.lastReadTs = Date.now(); }
        } else {
            const g = getGroupOrRoom(id);
            if (g) { g.messages = []; g.lastReadTs = Date.now(); }
        }
        saveState(true);
        notifyUpdate();
    }

    function deleteDmThread(pubkey) {
        delete state.dmThreads[pubkey];
        if (state.activeDmRecipient === pubkey) state.activeDmRecipient = null;
        saveState(true);
        notifyUpdate();
    }

    // ========== DM SURFACE ==========
    function startDm(pubkey, name = null) {
        if (!/^[0-9a-f]{64}$/i.test(pubkey || '') || pubkey === state.myPublicKey) return false;
        if (!state.dmThreads[pubkey]) {
            state.dmThreads[pubkey] = { name: name || lookupName(pubkey) || 'Skater', messages: [], lastReadTs: 0 };
        } else if (name) {
            state.dmThreads[pubkey].name = name;
        }
        state.dmThreads[pubkey].lastReadTs = Date.now();
        state.activeDmRecipient = pubkey;
        saveState();
        notifyUpdate();
        return true;
    }

    function closeDm() { state.activeDmRecipient = null; notifyUpdate(); }

    function openConversation(kind, id) {
        return kind === 'dm' ? startDm(id) : (switchGroup(id), true);
    }

    // ========== READ SURFACE ==========
    function unreadOfGroup(g) {
        return g.messages.filter(m => !m.mine && !m.system && m.ts > (g.lastReadTs || 0) && !Mutes.has(m.fromPubkey)).length;
    }
    function unreadOfThread(t, pubkey) {
        if (Mutes.has(pubkey)) return 0;
        return t.messages.filter(m => !m.mine && m.ts > (t.lastReadTs || 0)).length;
    }

    function previewOf(messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.system || Mutes.has(m.fromPubkey)) continue;
            const who = m.mine ? 'You: ' : '';
            if (m.type === 'share') return `${who}📤 shared a program`;
            if (m.type === 'guide') return `${who}📖 shared a guide`;
            return who + (m.text || '').slice(0, 48);
        }
        return null;
    }

    /** Unified conversation list: joined rooms + private groups + DM threads. */
    function getConversations() {
        const out = [];
        for (const g of Object.values(state.publicRooms)) {
            out.push({
                kind: 'group', isPublic: true, id: g.id, name: g.name, emoji: g.emoji || '🌐',
                unread: unreadOfGroup(g), lastTs: g.messages.length ? g.messages[g.messages.length - 1].ts : (g.createdAt || 0),
                preview: previewOf(g.messages) || 'Public room', online: onlineCount(g)
            });
        }
        for (const g of Object.values(state.groups)) {
            out.push({
                kind: 'group', isPublic: false, id: g.id, name: g.name, emoji: g.hasPassword ? '🔐' : '🔒',
                unread: unreadOfGroup(g), lastTs: g.messages.length ? g.messages[g.messages.length - 1].ts : (g.createdAt || 0),
                preview: previewOf(g.messages) || 'Invite friends to start chatting', online: onlineCount(g),
                hasPassword: !!g.hasPassword
            });
        }
        for (const [pubkey, t] of Object.entries(state.dmThreads)) {
            out.push({
                kind: 'dm', id: pubkey, name: t.name || 'Skater', emoji: null,
                unread: unreadOfThread(t, pubkey), lastTs: t.messages.length ? t.messages[t.messages.length - 1].ts : 0,
                preview: previewOf(t.messages) || 'No messages yet', muted: Mutes.has(pubkey)
            });
        }
        return out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    }

    // ========== PUBLIC SURFACE ==========
    async function init() {
        if (typeof NostrTools === 'undefined') { console.error('[SkateChat] NostrTools not loaded'); return; }
        loadState();
        initIdentity();
        Favorites.load();
        Mutes.load();

        for (const [key, room] of Object.entries(PUBLIC_ROOMS)) {
            if (!state.publicRoomSecrets[key]) state.publicRoomSecrets[key] = await Crypto.sha256(room.passphrase);
        }

        SkateNostr.onStatus(({ connected }) => {
            const online = connected > 0;
            [...Object.values(state.groups), ...Object.values(state.publicRooms)].forEach(g => { g.connected = online; });
            notifyUpdate();
        });
        SkateNostr.start();

        resubscribe();
        startPresence();

        // Tell the room you're gone the moment the tab closes — kills the
        // "2 online" ghost. pagehide (not visibilitychange) so tab switches
        // don't flicker everyone offline.
        window.addEventListener('pagehide', () => sendBye(allGroupIds()));

        notifyUpdate();
    }

    function onUpdate(cb) { state.callbacks.push(cb); cb(getState()); }

    function getState() {
        const activeGroup = state.activeIsPublic ? state.publicRooms[state.activeGroupId] : state.groups[state.activeGroupId] || null;
        const activeDmThread = state.activeDmRecipient ? state.dmThreads[state.activeDmRecipient] : null;

        let totalGroupUnread = 0;
        const perGroupUnread = {};
        [...Object.values(state.groups), ...Object.values(state.publicRooms)].forEach(g => {
            const u = unreadOfGroup(g);
            perGroupUnread[g.id] = u;
            totalGroupUnread += u;
        });
        let totalDmUnread = 0;
        Object.entries(state.dmThreads).forEach(([pk, t]) => { totalDmUnread += unreadOfThread(t, pk); });
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
            mutedCount: state.muted.size,
            publicRoomSecrets: state.publicRoomSecrets
        };
    }

    function getConnectionStatus() {
        return SkateNostr.connectedCount() > 0 ? 'connected' : 'disconnected';
    }

    function getPublicRooms() { return PUBLIC_ROOMS; }

    function getIdentity() { return { sk: state.mySecretKey, pk: state.myPublicKey, name: state.myName }; }

    return {
        init, createGroup, joinPublicRoom, leaveGroup, switchGroup, renameGroup,
        parseInviteHash, acceptInvite, getInviteInfo,
        sendMessage, shareProgram, shareGuide, voteTime, getVotes, retryMessage,
        startDm, sendDm, closeDm, openConversation, deleteDmThread, clearHistory,
        getConversations, getRoster,
        setDisplayName, getIdentity,
        onUpdate, getState, getConnectionStatus, getPublicRooms,
        Notify, Favorites, Crypto, Mutes
    };
})();

if (typeof module !== 'undefined') module.exports = SkateChat;
