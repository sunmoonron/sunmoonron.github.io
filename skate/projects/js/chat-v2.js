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
        MAX_MESSAGES: 200,       // persisted per conversation
        MAX_IN_MEMORY: 1000,     // v3.8: "Load earlier" may page in more for the session
        MAX_IMAGES_KEPT: 3,      // v3.8: photos persisted per thread (base64 eats the quota)
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

    // Default rooms + identity pools come from the central SkateConfig when
    // present; the inline fallback keeps this module self-contained.
    const DEFAULT_ROOMS = {
        leisure: { name: 'Leisure Skating', passphrase: 'toronto-leisure-skate-public-2025', emoji: '⛸️', desc: 'Casual skating & fun', autoJoin: true },
        shinny:  { name: 'Shinny Hockey',   passphrase: 'toronto-shinny-hockey-public-2025', emoji: '🏒', desc: 'Drop-in hockey games', autoJoin: true },
        figure:  { name: 'Figure Skating',  passphrase: 'toronto-figure-skate-public-2025', emoji: '⛸️', desc: 'Spins, jumps & grace', autoJoin: true },
        general: { name: 'General Chat',    passphrase: 'toronto-skating-general-public-2025', emoji: '💬', desc: 'Help, tips & chill', autoJoin: true, defaultActive: true },
        newbies: { name: 'New Skaters',     passphrase: 'toronto-new-skaters-public-2026', emoji: '🐣', desc: 'First laps, zero judgement', autoJoin: true }
    };
    const PUBLIC_ROOMS = (typeof window !== 'undefined' && window.SkateConfig?.rooms) || DEFAULT_ROOMS;
    // v3.8: the reaction palette (anything else on the wire is ignored)
    const REACTIONS = ['👍', '❤️', '😂', '🔥', '🙏', '⛸️'];

    const NAME_POOLS = (typeof window !== 'undefined' && window.SkateConfig?.identity) || {
        adjectives: ['Swift', 'Gliding', 'Frozen', 'Quick', 'Cool', 'Icy', 'Smooth', 'Fast', 'Chill', 'Frosty'],
        nouns: ['Skater', 'Penguin', 'Blade', 'Tiger', 'Bear', 'Fox', 'Wolf', 'Hawk', 'Star', 'Flash']
    };
    const ADJECTIVES = NAME_POOLS.adjectives;
    const NOUNS = NAME_POOLS.nouns;

    const state = {
        myName: null, mySecretKey: null, myPublicKey: null,
        groups: {},          // private groups: id -> group
        publicRooms: {},     // joined public rooms: id -> group
        activeGroupId: null, activeIsPublic: false,
        dmThreads: {},       // pubkey -> { name, messages[], lastReadTs }
        activeDmRecipient: null,
        callbacks: [],
        presenceTimer: null,
        muted: new Set(),    // pubkeys muted by ME (local only)
        publicRoomSecrets: {},
        seededRooms: false,  // default rooms auto-joined once (leaving is respected forever)
        subGeneration: 0,
        viewOpen: false      // v3.8: a conversation is on screen (presence is sent only for that room)
    };

    // ========== NOTIFICATIONS + FAVORITES ==========
    // v3.8: both live in always-loaded modules (ui.js, favorites.js) so the
    // schedule never needs this file; the old SkateChat.Notify / .Favorites
    // surface stays as thin aliases.
    const Notify = {
        toast: (m, t, d) => window.SkateUI.toast(m, t, d),
        updateTitle: (n) => window.SkateUI.updateTitle(n)
    };
    const Favorites = window.SkateFavorites;

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
                Notify.toast(`Muted ${name || 'user'}. Their messages are hidden for you.`, 'info', 3000);
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
        hashSync(str) { return window.SkateFavorites.hashSync(str); },
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

    // ========== PERSISTENCE (debounced, quota-safe) + v7 → v8 MIGRATION ==========
    let saveTimer = null, lastSavedJson = null;
    /** The persisted picture of the state at a given history budget (`cap` messages per conversation). */
    function snapshot(cap, imagesKept) {
        const slimMsgs = (list) => {
            const kept = list.slice(-cap);
            // older photos lose their pixels (a placeholder line stays) so a few
            // screenshots cannot fill the 5 MB the browser gives this site
            let images = 0;
            for (let i = kept.length - 1; i >= 0; i--) {
                const m = kept[i];
                if (m.type !== 'image' || !m.data?.src) continue;
                if (++images > imagesKept) kept[i] = { ...m, data: { expired: true } };
            }
            return kept;
        };
        const slim = (groups) => {
            const out = {};
            for (const [id, g] of Object.entries(groups)) {
                const { _online, historyDone, loadingOlder, ...rest } = g;   // paging flags are per session
                out[id] = { ...rest, messages: slimMsgs(g.messages) };
            }
            return out;
        };
        const threads = {};
        for (const [pk, t] of Object.entries(state.dmThreads)) { const { historyDone, loadingOlder, ...rest } = t; threads[pk] = { ...rest, messages: slimMsgs(t.messages) }; }
        return JSON.stringify({
            groups: slim(state.groups),
            publicRooms: slim(state.publicRooms),
            publicRoomSecrets: state.publicRoomSecrets,
            dmThreads: threads,
            threadsOwner: state.threadsOwner || null,
            dmArchive: state.dmArchive || {},
            activeGroupId: state.activeGroupId,
            activeIsPublic: state.activeIsPublic,
            seededRooms: state.seededRooms
        });
    }
    function saveState(immediate = false) {
        if (saveTimer) clearTimeout(saveTimer);
        const write = () => {
            saveTimer = null;
            // quota ladder: full budget → fewer photos → shorter history → give up loudly
            const plans = [[CONFIG.MAX_MESSAGES, CONFIG.MAX_IMAGES_KEPT], [CONFIG.MAX_MESSAGES, 1], [80, 0], [30, 0]];
            for (const [cap, imgs] of plans) {
                try {
                    const json = snapshot(cap, imgs);
                    if (json === lastSavedJson) return;
                    localStorage.setItem(CONFIG.STORAGE_KEY, json);
                    lastSavedJson = json;
                    return;
                } catch (e) {
                    if (!/quota|QUOTA|exceeded/i.test(String(e && (e.name || e.message)))) { console.warn('[SkateChat] save error:', e); return; }
                }
            }
            console.warn('[SkateChat] storage full: chat history not saved this time');
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
        delete g.votes;              // v3.2: time votes were cut
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
            state.threadsOwner = p.threadsOwner || null;
            state.dmArchive = p.dmArchive || {};
            state.activeGroupId = p.activeGroupId || null;
            state.activeIsPublic = p.activeIsPublic || false;
            state.seededRooms = !!p.seededRooms;
            Object.values(state.groups).concat(Object.values(state.publicRooms)).forEach(migrateGroupShape);
        } catch (e) { console.warn('[SkateChat] load error:', e); }
    }

    // ========== UPDATE FANOUT (throttled) ==========
    // One fan-out per frame while the tab draws; a background tab gets no
    // frames, so a timer takes over there (the title's unread count and the
    // list must still move while you are on another tab).
    let notifyPending = false;
    function notifyUpdate() {
        if (notifyPending) return;
        notifyPending = true;
        let done = false;
        const run = () => {
            if (done) return;
            done = true;
            notifyPending = false;
            const s = getState();
            state.callbacks.forEach(cb => { try { cb(s); } catch (e) { console.warn('[SkateChat] update handler failed:', e); } });
        };
        const fallback = setTimeout(run, document.visibilityState === 'hidden' ? 30 : 400);
        requestAnimationFrame(() => { clearTimeout(fallback); run(); });
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
                    // explicit goodbye: drop them from the online window immediately,
                    // and wipe the roster entry outright when nothing they wrote is
                    // still in the history (👻 invisible must leave no trace).
                    if (group.roster?.[event.pubkey]) {
                        const wrote = (group.messages || []).some(m => m.fromPubkey === event.pubkey && !m.system);
                        if (wrote) group.roster[event.pubkey].last = 0;
                        else delete group.roster[event.pubkey];
                    }
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
        // 👻 A message from an invisible member must not flip them "online":
        // the payload says so (inv), and we then keep the name but never
        // the timestamp. (Old bug: any chat message counted as presence.)
        trackMember(group, c.from, event.pubkey, c.inv ? 0 : ts);

        if (c.type === 'vote') return;   // v3.2: time votes were cut; older clients may still send them

        // v3.8: reactions and unsends ride the same encrypted channel
        if (c.type === 'react') {
            if (!REACTIONS.includes(c.e) || typeof c.to !== 'string') return;
            const target = group.messages.find(m => m.id === c.to);
            if (target) setReaction(target, event.pubkey, c.e, !!c.on);
            else {
                const list = pendingReacts.get(c.to) || [];
                if (list.length < 50) list.push({ pk: event.pubkey, emoji: c.e, on: !!c.on });
                pendingReacts.set(c.to, list);
                if (pendingReacts.size > 500) pendingReacts.delete(pendingReacts.keys().next().value);
            }
            saveState(); notifyUpdate();
            return;
        }
        if (c.type === 'delete') {
            if (typeof c.to !== 'string') return;
            const target = group.messages.find(m => m.id === c.to);
            if (target && target.fromPubkey === event.pubkey && !target.system) { markDeleted(target); saveState(); notifyUpdate(); }
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
        if (!mine && !c.system && mentionsMe(msg.text)) msg.mention = true;
        const wasNew = addMessage(group, msg);
        if (wasNew && !mine && !c.system && ts > (group.lastReadTs || 0) && state.activeGroupId === group.id && state.viewOpen && document.visibilityState === 'visible') {
            group.lastReadTs = ts; // viewing it live: auto-read
        }
        if (wasNew && msg.mention && ts > bootTs) maybeNotify('group', group.id, `${msg.from || 'Someone'} mentioned you in ${group.name}`, msg.text);
        saveState();
        notifyUpdate();
    }

    function markDeleted(msg) {
        msg.deleted = true; msg.text = ''; msg.data = null; msg.replyTo = null; delete msg.reacts; delete msg.mention;
    }
    /** "@YourName" anywhere in the text (word-bounded, case-insensitive). */
    function mentionsMe(text) {
        const n = state.myName;
        if (!n || !text) return false;
        return new RegExp('@' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])', 'i').test(text);
    }
    /**
     * v3.8: a system notification for a DM or a mention while the tab is in
     * the background, if the visitor switched Notify on and the browser
     * allows it (iOS Safari does not, and says so in Settings).
     */
    function maybeNotify(kind, id, title, body) {
        if (window.SkateSettings?.get('notifyDesktop') !== true) return;
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        if (document.visibilityState === 'visible') return;
        try {
            const n = new Notification(title, { body: String(body || '').slice(0, 140), tag: `skate-${kind}-${id}` });
            n.onclick = () => { try { window.focus(); } catch {} n.close(); window.SkateApp?.Actions?.jumpToConversation?.(kind, id); };
        } catch {}
    }

    function addMessage(group, msg) {
        if (group.messages.some(m => m.id === msg.id)) return false;
        // Replace optimistic local echo when the relay copy arrives
        const localIdx = msg.mine ? group.messages.findIndex(m => m.localId && m.text === msg.text && Math.abs(m.ts - msg.ts) < 15000) : -1;
        if (localIdx > -1) { group.messages[localIdx] = msg; applyPendingReacts(group, msg); return false; }
        group.messages.push(msg);
        group.messages.sort((a, b) => a.ts - b.ts);
        if (group.messages.length > CONFIG.MAX_IN_MEMORY) group.messages = group.messages.slice(-CONFIG.MAX_IN_MEMORY);
        applyPendingReacts(group, msg);
        return true;
    }

    // Reactions can arrive before the message they belong to (relays answer in
    // any order): park them, apply when the message shows up.
    const pendingReacts = new Map();   // msgId → [{pk, emoji, on}]
    function applyPendingReacts(conv, msg) {
        const list = pendingReacts.get(msg.id);
        if (!list) return;
        pendingReacts.delete(msg.id);
        list.forEach(r => setReaction(msg, r.pk, r.emoji, r.on));
    }
    function setReaction(msg, pk, emoji, on) {
        msg.reacts ||= {};
        const set = new Set(msg.reacts[emoji] || []);
        if (on) set.add(pk); else set.delete(pk);
        if (set.size) msg.reacts[emoji] = [...set].slice(0, 200); else delete msg.reacts[emoji];
        if (!Object.keys(msg.reacts).length) delete msg.reacts;
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
        return Object.entries(group.roster || {})
            .filter(([pk, m]) => (m.last || 0) > cutoff && !(pk === state.myPublicKey && isInvisible()))
            .length;
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

    // ========== DMs ==========
    function handleDm(event) {
        const pTag = (event.tags || []).find(t => t[0] === 'p');
        if (!pTag) return;
        const isFromMe = event.pubkey === state.myPublicKey;
        const isForMe = pTag[1] === state.myPublicKey;
        if (!isForMe && !isFromMe) return;

        const otherPubkey = isFromMe ? pTag[1] : event.pubkey;

        // ✉️ DMs disabled: silently drop INCOMING private messages (no
        // thread, no notification — senders aren't told). Your own sent
        // DMs still echo so conversations you start keep working. The dev
        // inbox is the exception: a device holding the dev key exists to
        // receive, whatever the privacy switch says.
        const devInbox = state.myPublicKey === (window.SkateConfig?.devPubkey || window.SkateConfig?.ownerPubkey);
        if (!isFromMe && !devInbox && window.SkateSettings?.get('dmsAllowed') === false) return;

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

        // A photo arrives as numbered parts (the relay caps an event at 64 KB);
        // it becomes one image message once every part is here.
        if (c.type === 'attach') {
            if (typeof c.id !== 'string' || !/^[0-9a-f]{6,32}$/.test(c.id) || !(c.of >= 1 && c.of <= 12) || !(c.part >= 0 && c.part < c.of)) return;
            if (typeof c.data !== 'string' || c.data.length > 60000 || !/^image\/(jpeg|png|webp)$/.test(c.mime || '')) return;
            const box = (state.dmAttach ||= {});
            const key = `${otherPubkey}|${c.id}`;
            const a = (box[key] ||= { parts: {}, of: c.of, mime: c.mime, ts, mine: isFromMe });
            a.parts[c.part] = c.data;
            if (Object.keys(a.parts).length < a.of) return;
            const b64 = Array.from({ length: a.of }, (_, i) => a.parts[i]).join('');
            delete box[key];
            if (isFromMe && thread.messages.some(m => m.localId && m.type === 'image' && m.attachId === c.id)) {
                const mine = thread.messages.find(m => m.localId && m.type === 'image' && m.attachId === c.id);
                mine.status = 'sent'; mine.id = event.id; delete mine.localId;
            } else if (!thread.messages.some(m => m.attachId === c.id)) {
                thread.messages.push({ id: event.id, attachId: c.id, type: 'image', text: '', from: isFromMe ? state.myName : thread.name, mine: isFromMe, ts, data: { src: `data:${a.mime};base64,${b64}` }, status: 'sent' });
                thread.messages.sort((x, y) => x.ts - y.ts);
            }
            if (thread.messages.length > 100) thread.messages = thread.messages.slice(-100);
            saveState();
            notifyUpdate();
            return;
        }

        if (c.type === 'react') {
            if (!REACTIONS.includes(c.e) || typeof c.to !== 'string') return;
            const target = thread.messages.find(m => m.id === c.to);
            if (target) { setReaction(target, event.pubkey, c.e, !!c.on); saveState(); notifyUpdate(); }
            return;
        }
        if (c.type === 'delete') {
            if (typeof c.to !== 'string') return;
            const target = thread.messages.find(m => m.id === c.to);
            if (target && (target.mine ? isFromMe : event.pubkey === otherPubkey)) { markDeleted(target); saveState(); notifyUpdate(); }
            return;
        }

        const localIdx = isFromMe ? thread.messages.findIndex(m => m.localId && m.text === c.text && Math.abs(m.ts - ts) < 15000) : -1;
        const msg = {
            id: event.id,
            type: c.type === 'share' ? 'share' : (c.type === 'guide' ? 'guide' : 'chat'),
            text: SkateMod.clean(c.text || ''),
            from: isFromMe ? state.myName : thread.name,
            mine: isFromMe, ts, data: c.ctx ? { ...(c.data || {}), ctx: String(c.ctx).slice(0, 200) } : c.data, replyTo: sanitizeReplyRef(c.replyTo), status: 'sent'
        };
        let fresh = false;
        if (localIdx > -1) thread.messages[localIdx] = msg;
        else { thread.messages.push(msg); thread.messages.sort((a, b) => a.ts - b.ts); fresh = !isFromMe; }
        if (thread.messages.length > CONFIG.MAX_IN_MEMORY) thread.messages = thread.messages.slice(-CONFIG.MAX_IN_MEMORY);

        if (!isFromMe && ts > (thread.lastReadTs || 0) && state.activeDmRecipient === otherPubkey && state.viewOpen && document.visibilityState === 'visible') thread.lastReadTs = ts;
        if (fresh && ts > bootTs && !Mutes.has(otherPubkey)) maybeNotify('dm', otherPubkey, thread.name, msg.type === 'chat' ? msg.text : (msg.type === 'share' ? 'shared a session' : 'shared a guide'));
        saveState();
        notifyUpdate();
    }

    // ========== v3.8: REACTIONS, UNSEND, PAGING ==========
    function findMsg(kind, convId, msgId) {
        const list = kind === 'dm' ? state.dmThreads[convId]?.messages : getGroupOrRoom(convId)?.messages;
        return { list, msg: (list || []).find(m => m.id === msgId) || null };
    }
    /** Toggle my reaction on a delivered message (optimistic; rolled back if no relay takes it). */
    async function react(kind, convId, msgId, emoji) {
        if (!REACTIONS.includes(emoji)) return false;
        const { msg } = findMsg(kind, convId, msgId);
        if (!msg || msg.localId || msg.deleted || msg.system) return false;
        const me = state.myPublicKey;
        const on = !(msg.reacts?.[emoji] || []).includes(me);
        setReaction(msg, me, emoji, on);
        saveState(); notifyUpdate();
        const payload = { type: 'react', to: msgId, e: emoji, on: on ? 1 : 0, text: on ? emoji : '', from: state.myName, fromName: state.myName };
        const { ok } = kind === 'dm' ? await publishDm(convId, payload) : await publishToGroup(convId, payload);
        if (!ok) { setReaction(msg, me, emoji, !on); saveState(); notifyUpdate(); }
        return ok;
    }
    /** Unsend my own delivered message: everyone's client blanks it, and a NIP-09 deletion asks the relays to drop it. */
    async function unsend(kind, convId, msgId) {
        const { msg } = findMsg(kind, convId, msgId);
        if (!msg || !msg.mine || msg.localId || msg.deleted) return false;
        markDeleted(msg);
        saveState(); notifyUpdate();
        const payload = { type: 'delete', to: msgId, text: '', from: state.myName, fromName: state.myName };
        const r = kind === 'dm' ? await publishDm(convId, payload) : await publishToGroup(convId, payload);
        try { await signAndSend({ kind: 5, content: 'unsent', tags: [['e', msgId]], created_at: Math.floor(Date.now() / 1000) }, SkateMod.POW.chat); } catch {}
        return r.ok;
    }
    /** Page older history in from the relays (one-shot query before the oldest message we hold). */
    async function loadOlder(kind, convId) {
        const conv = kind === 'dm' ? state.dmThreads[convId] : getGroupOrRoom(convId);
        if (!conv || conv.historyDone || conv.loadingOlder) return 0;
        const oldest = conv.messages.find(m => !m.localId);
        const until = oldest ? Math.floor(oldest.ts / 1000) - 1 : Math.floor(Date.now() / 1000);
        conv.loadingOlder = true; notifyUpdate();
        const before = conv.messages.length;
        const filters = kind === 'dm'
            ? [{ kinds: [CONFIG.KINDS.DM], authors: [convId], '#p': [state.myPublicKey], until, limit: 60 },
               { kinds: [CONFIG.KINDS.DM], authors: [state.myPublicKey], '#p': [convId], until, limit: 60 }]
            : [{ kinds: [CONFIG.KINDS.GROUP], '#g': [convId], until, limit: 80 }];
        try { await SkateNostr.subOnce(filters, handleIncoming, 8000); } catch {}
        conv.loadingOlder = false;
        const added = conv.messages.length - before;
        if (added === 0) conv.historyDone = true;
        saveState(); notifyUpdate();
        return added;
    }

    // ========== SEND PIPELINE ==========
    /**
     * v3.8: the relay pool never re-processes our own events (publish() marks
     * them seen), so the optimistic echo was keeping its local_ id forever:
     * reactions others sent to the real id never matched, and unsend was
     * impossible. The moment a relay accepts the event, the echo becomes it.
     */
    function settle(m, ok, event) {
        if (!m) return;
        m.status = ok ? 'sent' : 'failed';
        if (ok && event) { m.id = event.id; delete m.localId; delete m.payload; }
    }

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
        if (isInvisible()) payload = { ...payload, inv: 1 };   // receivers: keep my name, not my "last seen"
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

    /** Moderation context: public rooms get the remote APIs (unless the
     *  visitor switched them off in Settings → 🛡️); private stays on-device.
     *  The local word list always runs — it's the mandatory floor. */
    function moderationOpts(groupOrNullForDm) {
        const isPublic = !!groupOrNullForDm?.isPublic;
        const remoteAllowed = window.SkateSettings?.get('remoteModeration') !== false;
        return { remote: isPublic && remoteAllowed };
    }

    async function sendMessage(text, replyTo = null) {
        const groupId = state.activeGroupId;
        const group = getGroupOrRoom(groupId);
        if (!group || !text.trim()) return false;
        const trimmed = text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);

        const verdict = await SkateMod.check(trimmed, moderationOpts(group));
        if (!verdict.ok) {
            Notify.toast('That message will not fly here. Keep it friendly.', 'error', 3000);
            return false;
        }

        const payload = { type: 'chat', text: trimmed, from: state.myName };
        if (replyTo) payload.replyTo = sanitizeReplyRef(replyTo);

        const localId = 'local_' + Crypto.randomHex(6);
        const echo = { id: localId, localId, type: 'chat', text: trimmed, from: state.myName, fromPubkey: state.myPublicKey, mine: true, ts: Date.now(), replyTo: payload.replyTo || null, status: 'pending', payload };
        group.messages.push(echo);
        notifyUpdate();

        const { ok, event } = await publishToGroup(groupId, payload);
        settle(group.messages.find(x => x.id === localId), ok, event);
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

        const { ok, event } = await publishDm(to, payload);
        settle(thread.messages.find(x => x.id === localId), ok, event);
        saveState();
        notifyUpdate();
        return ok;
    }

    /**
     * The dev chat's send: to any pubkey, up to 2000 characters, no cloud
     * moderation (it is a private message to the site owner), optimistic
     * echo like sendDm. `payload` may carry ctx (bug context) or data.
     */
    async function sendDmTo(toPubkey, payload, echoText = '') {
        if (!/^[0-9a-f]{64}$/i.test(toPubkey || '') || !state.mySecretKey) return false;
        if (!state.dmThreads[toPubkey]) state.dmThreads[toPubkey] = { name: payload.toName || lookupName(toPubkey) || 'Skater', messages: [], lastReadTs: 0 };
        const thread = state.dmThreads[toPubkey];
        const text = String(payload.text || echoText || '').slice(0, 2000);
        const body = { ...payload, text };
        const localId = 'local_' + Crypto.randomHex(6);
        thread.messages.push({ id: localId, localId, type: 'chat', text, from: state.myName, mine: true, ts: Date.now(), status: 'pending', payload: body, data: body.ctx ? { ctx: body.ctx } : undefined });
        notifyUpdate();
        const { ok, event } = await publishDm(toPubkey, body);
        settle(thread.messages.find(x => x.id === localId), ok, event);
        saveState();
        notifyUpdate();
        return ok;
    }

    /** A photo as chunked DMs (≤ 40 KB of base64 each). Echoes locally at once. */
    async function sendDmImage(toPubkey, dataUrl, meta = {}) {
        const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
        if (!m || !/^[0-9a-f]{64}$/i.test(toPubkey || '')) return false;
        const [, mime, b64] = m;
        const CH = 40000, of = Math.ceil(b64.length / CH);
        if (of > 12) return false;
        if (!state.dmThreads[toPubkey]) state.dmThreads[toPubkey] = { name: meta.toName || lookupName(toPubkey) || 'Skater', messages: [], lastReadTs: 0 };
        const thread = state.dmThreads[toPubkey];
        const id = Crypto.randomHex(8);
        const localId = 'local_' + id;
        thread.messages.push({ id: localId, localId, attachId: id, type: 'image', text: '', from: state.myName, mine: true, ts: Date.now(), status: 'pending', data: { src: dataUrl } });
        notifyUpdate();
        let ok = true, last = null;
        for (let part = 0; part < of; part++) {
            const r = await publishDm(toPubkey, { type: 'attach', id, part, of, mime, data: b64.slice(part * CH, (part + 1) * CH), fromName: meta.fromName || state.myName });
            ok = ok && r.ok;
            last = r.event || last;
        }
        const mm = thread.messages.find(x => x.id === localId);
        settle(mm, ok, last);   // the receiver files the photo under its final part's id too
        saveState();
        notifyUpdate();
        return ok;
    }

    /**
     * Private threads belong to a key, not to the device. When the device's
     * key changes (import, reset), the old key's threads are archived (kept
     * in storage, never shown) and the new key starts clean; the relay
     * replays the new key's last 30 days on subscribe. A thread addressed
     * to one's own key (the visitor→dev thread, after importing the dev key)
     * is dropped: it cannot be a conversation with oneself.
     */
    function adoptThreads() {
        const me = state.myPublicKey;
        if (!me) return;
        state.dmArchive ||= {};
        if (state.threadsOwner && state.threadsOwner !== me) {
            if (Object.keys(state.dmThreads).length) state.dmArchive[state.threadsOwner] = state.dmThreads;
            state.dmThreads = {};
            state.activeDmRecipient = null;
            state.dmAttach = {};
        }
        if (state.dmThreads[me]) delete state.dmThreads[me];
        state.threadsOwner = me;
        saveState();
    }

    /** Owner side: run this device as a given key (hex or nsec) so the dev inbox is readable. */
    function importIdentity(str) {
        // phones capitalise or pad pasted text: bech32 is case-insensitive as a whole, so lowercase it all
        let hex = String(str || '').trim().replace(/\s+/g, '').toLowerCase();
        try {
            if (hex.startsWith('nsec1')) {
                const d = NostrTools.nip19.decode(hex);
                hex = typeof d.data === 'string' ? d.data : Array.from(d.data, b => b.toString(16).padStart(2, '0')).join('');
            }
        } catch { return false; }
        if (!/^[0-9a-f]{64}$/.test(hex)) return false;
        state.mySecretKey = Crypto.hexToBytes(hex);
        state.myPublicKey = NostrTools.getPublicKey(state.mySecretKey);
        saveIdentity();
        adoptThreads();
        try { resubscribe(); } catch {}
        notifyUpdate();
        return state.myPublicKey;
    }

    /** A fresh random key for this device. Saved sessions, settings and local chat history stay. */
    function resetIdentity() {
        state.mySecretKey = NostrTools.generateSecretKey();
        state.myPublicKey = NostrTools.getPublicKey(state.mySecretKey);
        saveIdentity();
        adoptThreads();
        try { resubscribe(); } catch {}
        notifyUpdate();
        return state.myPublicKey;
    }

    /** Retry a failed optimistic message (group or DM). */
    async function retryMessage(kind, convId, localId) {
        const list = kind === 'dm' ? state.dmThreads[convId]?.messages : getGroupOrRoom(convId)?.messages;
        const m = list?.find(x => x.localId === localId && x.status === 'failed');
        if (!m || !m.payload) return false;
        m.status = 'pending';
        m.ts = Date.now(); // refresh the echo-replacement window
        notifyUpdate();
        const { ok, event } = kind === 'dm' ? await publishDm(convId, m.payload) : await publishToGroup(convId, m.payload);
        settle(m, ok, event);
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
        const card = {
            activity, location, date: dateDisplay,
            time: program['Start Time'] || '', endTime: program['End Time'] || '',
            programId: Favorites.getId(program)
        };
        // Official page (toronto.ca location page / venue site) so recipients
        // can verify the schedule for themselves before travelling.
        const official = window.SkateApp?.officialUrl?.(program);
        if (official) { card.official = official; card.site = window.SkateApp?.officialSite?.(program) || ''; }
        // Paid venues: the recipient must know money changes hands BEFORE
        // they show up — carry the flag + exact price on the wire.
        if (program.Paid) {
            card.paid = true;
            const p = Number(program.Price);
            if (Number.isFinite(p) && p > 0) card.price = p;
        }
        if (program.PriceNote) card.note = String(program.PriceNote).slice(0, 120);   // e.g. residents-only free
        // Municipality for the recipient's map link (external venues sit in
        // Stouffville, Oshawa, Vaughan… — the same rule as the app's city chips).
        const city = window.SkateConfig?.sourceInfo?.[program.Source || 'city']?.city || program.District || '';
        if (city && city !== 'Toronto') card.city = String(city).slice(0, 40);
        return card;
    }

    async function shareTo(dest, payload) {
        if (dest.kind === 'dm') {
            const thread = state.dmThreads[dest.id] || (state.dmThreads[dest.id] = { name: dest.name || lookupName(dest.id) || 'Skater', messages: [], lastReadTs: 0 });
            const localId = 'local_' + Crypto.randomHex(6);
            const dmPayload = { ...payload, fromName: state.myName, toName: thread.name };
            thread.messages.push({ id: localId, localId, type: payload.type, text: payload.text, from: state.myName, mine: true, ts: Date.now(), data: payload.data, status: 'pending', payload: dmPayload });
            notifyUpdate();
            const { ok, event } = await publishDm(dest.id, dmPayload);
            settle(thread.messages.find(x => x.id === localId), ok, event);
            saveState(); notifyUpdate();
            return ok;
        }

        // Group shares get the SAME optimistic local echo as text sends —
        // without it the sender only ever saw their share if a relay echoed
        // their own event back through the subscription (many don't → the
        // "I shared it but can't see it, others can" bug). addMessage()
        // later swaps this echo for the relay copy via the localId match.
        const group = getGroupOrRoom(dest.id);
        const full = { ...payload, from: state.myName };
        if (group) {
            const localId = 'local_' + Crypto.randomHex(6);
            group.messages.push({
                id: localId, localId, type: payload.type, text: payload.text,
                from: state.myName, fromPubkey: state.myPublicKey, mine: true,
                ts: Date.now(), data: payload.data, status: 'pending', payload: full
            });
            notifyUpdate();
            const { ok, event } = await publishToGroup(dest.id, full);
            settle(group.messages.find(x => x.id === localId), ok, event);
            saveState(); notifyUpdate();
            return ok;
        }
        const { ok } = await publishToGroup(dest.id, full);
        return ok;
    }

    async function shareProgram(program, dest) {
        const data = programCard(program);
        const target = dest || (state.activeGroupId ? { kind: 'group', id: state.activeGroupId } : null);
        if (!target) return false;
        const ok = await shareTo(target, { type: 'share', text: `⛸️ ${data.activity}`, data });
        if (ok) Notify.toast(`Shared to ${target.name || 'the chat'} 📤`, 'success', 2000);
        else Notify.toast('The share did not reach the relays. Try again.', 'error');
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
        else Notify.toast('The share did not reach the relays. Try again.', 'error');
        return ok;
    }

    // ========== PRESENCE ==========
    function presenceTemplate(group, gid, status) {
        return {
            kind: CONFIG.KINDS.PRESENCE,
            content: Crypto.encryptForGroup(JSON.stringify({ from: state.myName, s: status }), group.secret),
            tags: [['g', gid]],
            created_at: Math.floor(Date.now() / 1000)
        };
    }
    function presenceEvent(group, gid, status) {
        return NostrTools.finalizeEvent(presenceTemplate(group, gid, status), state.mySecretKey);
    }
    /** Heartbeat with the cheap chat-tier PoW (a few ms) so the site's own
     *  relay — which enforces the PoW table — accepts it too. */
    async function publishBeat(group, gid) {
        let tpl = presenceTemplate(group, gid, 'on');
        try { tpl = await SkateMod.mine({ ...tpl, pubkey: state.myPublicKey }, SkateMod.POW.chat); } catch {}
        return SkateNostr.publish(NostrTools.finalizeEvent(tpl, state.mySecretKey), 3000);
    }

    // 👻 Invisible mode: skip every outgoing presence ping — others stop
    // seeing you in rosters/"here now"; you still read & send normally.
    const isInvisible = () => window.SkateSettings?.get('invisible') === true;

    /**
     * v3.8: presence means "in this room right now". One heartbeat for the
     * room on screen (not one per joined room every 45 s, which at a few
     * hundred visitors was most of the relay traffic), a goodbye when you
     * leave it, nothing while the tab is hidden or a DM is open. The counts
     * in the list and on the room cards become honest "here now" numbers.
     */
    const presenceGroupId = () =>
        (state.viewOpen && !state.activeDmRecipient && document.visibilityState === 'visible') ? state.activeGroupId : null;
    function beatNow() {
        if (isInvisible()) return;
        const gid = presenceGroupId(), group = gid && getGroupOrRoom(gid);
        if (group) publishBeat(group, gid).catch(() => {});
    }
    function startPresence() {
        stopPresence();
        beatNow();
        state.presenceTimer = setInterval(beatNow, CONFIG.PRESENCE_INTERVAL);
    }
    /** The app says whether a conversation is on screen; leaving it says goodbye. */
    function setViewOpen(open) {
        const was = presenceGroupId();
        state.viewOpen = !!open;
        const now = presenceGroupId();
        if (was && was !== now && !isInvisible()) sendBye([was]);
        if (now && now !== was) beatNow();
    }

    /** Called when the privacy toggles flip: going invisible broadcasts a
     *  bye so existing "online" entries clear instead of aging out. */
    function applyPrivacy() {
        if (isInvisible()) sendBye(allGroupIds());
        notifyUpdate();
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
            messages: [], connected: false,
            lastReadTs: Date.now(), createdAt: Date.now(),
            ...extra
        };
    }

    /**
     * BUGFIX (autojoin): first run on a device seeds every room flagged
     * `autoJoin` in the config, so General Chat + the other defaults are
     * there from the get-go. This also makes the program 👍 vote button
     * visible on day one — it's gated on having an active group, which
     * fresh users never had before.
     *
     * Runs exactly once (the `seededRooms` flag persists), so leaving a
     * room later is respected forever. Silent by design: no join-toast
     * spam, one resubscribe handled by init() right after.
     */
    async function seedDefaultRooms() {
        if (state.seededRooms) return;
        state.seededRooms = true;
        let defaultActiveId = null;
        for (const [key, room] of Object.entries(PUBLIC_ROOMS)) {
            if (!room.autoJoin) continue;
            const secret = state.publicRoomSecrets[key];   // computed in init()
            if (!secret) continue;
            const groupId = Crypto.deriveGroupId(secret);
            if (room.defaultActive) defaultActiveId = groupId;
            if (state.publicRooms[groupId]) continue;      // already a member
            state.publicRooms[groupId] = makeGroup(groupId, room.name, secret, { isPublic: true, roomKey: key, emoji: room.emoji });
        }
        if (!state.activeGroupId && defaultActiveId && state.publicRooms[defaultActiveId]) {
            state.activeGroupId = defaultActiveId;
            state.activeIsPublic = true;
        }
        saveState(true);
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
        publishToGroup(groupId, { type: 'chat', text: `${state.myName} created the group`, from: state.myName, system: true });
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
            publishToGroup(groupId, { type: 'chat', text: `${state.myName} joined the group`, from: state.myName, system: true });
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
        const { ok } = await publishToGroup(groupId, { type: 'rename', name, from: state.myName });
        if (!ok) Notify.toast('Renamed on this device. The relays did not confirm, so others may not see it yet.', 'info', 3500);
        return ok;
    }

    function leaveGroup(groupId) {
        const isPublic = !!state.publicRooms[groupId];
        const group = isPublic ? state.publicRooms[groupId] : state.groups[groupId];
        if (!group) return;
        sendBye([groupId]); // clear the "still online" ghost for everyone else
        if (!isPublic) publishToGroup(groupId, { type: 'chat', text: `${state.myName} left the group`, from: state.myName, system: true });
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
        const was = presenceGroupId();
        state.activeGroupId = groupId;
        state.activeIsPublic = !!state.publicRooms[groupId];
        state.activeDmRecipient = null;
        group.lastReadTs = Date.now();
        if (was && was !== groupId && !isInvisible()) sendBye([was]);
        if (presenceGroupId() && presenceGroupId() !== was) beatNow();
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
        const was = presenceGroupId();
        state.activeDmRecipient = pubkey;
        if (was && !isInvisible()) sendBye([was]);   // a DM on screen: not "in" the room any more
        saveState();
        notifyUpdate();
        return true;
    }

    function closeDm() { state.activeDmRecipient = null; beatNow(); notifyUpdate(); }

    function openConversation(kind, id) {
        return kind === 'dm' ? startDm(id) : (switchGroup(id), true);
    }

    // ========== READ SURFACE ==========
    function unreadOfGroup(g) {
        return g.messages.filter(m => !m.mine && !m.system && !m.deleted && m.ts > (g.lastReadTs || 0) && !Mutes.has(m.fromPubkey)).length;
    }
    function mentionsOfGroup(g) {
        return g.messages.filter(m => m.mention && !m.mine && !m.deleted && m.ts > (g.lastReadTs || 0) && !Mutes.has(m.fromPubkey)).length;
    }
    function unreadOfThread(t, pubkey) {
        if (Mutes.has(pubkey)) return 0;
        return t.messages.filter(m => !m.mine && !m.deleted && m.ts > (t.lastReadTs || 0)).length;
    }

    function previewOf(messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.system || Mutes.has(m.fromPubkey)) continue;
            const who = m.mine ? 'You: ' : '';
            if (m.deleted) return `${who}message deleted`;
            if (m.type === 'image') return `${who}📷 photo`;
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
                unread: unreadOfGroup(g), mentions: mentionsOfGroup(g), lastTs: g.messages.length ? g.messages[g.messages.length - 1].ts : (g.createdAt || 0),
                preview: previewOf(g.messages) || 'Public room', online: onlineCount(g)
            });
        }
        for (const g of Object.values(state.groups)) {
            out.push({
                kind: 'group', isPublic: false, id: g.id, name: g.name, emoji: g.hasPassword ? '🔐' : '🔒',
                unread: unreadOfGroup(g), mentions: mentionsOfGroup(g), lastTs: g.messages.length ? g.messages[g.messages.length - 1].ts : (g.createdAt || 0),
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
    let booted = false, pagehideHooked = false, storageHooked = false, bootTs = 0;

    /**
     * v3.8: two tabs of the site each hold the whole chat state and both
     * save it; without merging, the last writer silently dropped whatever
     * the other tab had received. Messages are unioned by id, read markers
     * take the latest, a group left in the other tab is left here too.
     */
    function mergeFromOtherTab(json) {
        let p;
        try { p = JSON.parse(json); } catch { return; }
        if (!p || typeof p !== 'object') return;
        if (p.threadsOwner && state.threadsOwner && p.threadsOwner !== state.threadsOwner) return;   // a different key's threads
        let resub = false;
        const mergeMsgs = (mine, theirs) => {
            const ids = new Set(mine.map(m => m.id));
            (theirs || []).forEach(m => { if (m && !ids.has(m.id) && !m.localId) mine.push(m); });
            mine.sort((a, b) => a.ts - b.ts);
            if (mine.length > CONFIG.MAX_IN_MEMORY) mine.splice(0, mine.length - CONFIG.MAX_IN_MEMORY);
        };
        const mergeGroups = (local, theirs) => {
            for (const [id, g] of Object.entries(theirs || {})) {
                if (!local[id]) { local[id] = migrateGroupShape(g); resub = true; continue; }
                const mine = local[id];
                mergeMsgs(mine.messages, g.messages);
                mine.lastReadTs = Math.max(mine.lastReadTs || 0, g.lastReadTs || 0);
                if ((g.renamedAt || 0) > (mine.renamedAt || 0)) { mine.name = g.name; mine.renamedAt = g.renamedAt; }
                for (const [pk, m] of Object.entries(g.roster || {})) {
                    const r = mine.roster[pk] || { name: m.name, last: 0 };
                    if ((m.last || 0) >= (r.last || 0)) { r.name = m.name || r.name; r.last = Math.max(r.last || 0, m.last || 0); }
                    mine.roster[pk] = r;
                }
            }
            for (const id of Object.keys(local)) {
                if (!(theirs || {})[id] && !local[id].messages.some(m => m.localId)) { delete local[id]; resub = true; }   // left elsewhere
            }
        };
        mergeGroups(state.groups, p.groups);
        mergeGroups(state.publicRooms, p.publicRooms);
        for (const [pk, t] of Object.entries(p.dmThreads || {})) {
            if (!state.dmThreads[pk]) { state.dmThreads[pk] = t; continue; }
            const mine = state.dmThreads[pk];
            mergeMsgs(mine.messages, t.messages);
            mine.lastReadTs = Math.max(mine.lastReadTs || 0, t.lastReadTs || 0);
            if (t.name) mine.name = t.name;
        }
        state.publicRoomSecrets = { ...(p.publicRoomSecrets || {}), ...state.publicRoomSecrets };
        state.seededRooms = state.seededRooms || !!p.seededRooms;
        if (state.activeGroupId && !getGroupOrRoom(state.activeGroupId)) { state.activeGroupId = null; state.activeIsPublic = false; }
        if (resub) resubscribe();
        notifyUpdate();
    }

    /** Messages that never reached a relay (offline, timeout) go out again by themselves, newest last, within a day. */
    let resending = false;
    async function resendUnsent() {
        if (resending || !booted) return;
        resending = true;
        try {
            const cutoff = Date.now() - 86400000;
            const jobs = [];
            allGroupIds().forEach(id => (getGroupOrRoom(id)?.messages || []).forEach(m => { if (m.localId && m.payload && m.status === 'failed' && m.ts > cutoff) jobs.push(['group', id, m.localId]); }));
            Object.entries(state.dmThreads).forEach(([pk, t]) => t.messages.forEach(m => { if (m.localId && m.payload && m.status === 'failed' && m.ts > cutoff) jobs.push(['dm', pk, m.localId]); }));
            for (const [kind, id, localId] of jobs.slice(0, 20)) {
                await retryMessage(kind, id, localId);
                await new Promise(r => setTimeout(r, 150));
            }
        } finally { resending = false; }
    }
    async function init() {
        if (typeof NostrTools === 'undefined') { console.error('[SkateChat] NostrTools not loaded'); return; }
        if (booted) return;
        booted = true;
        bootTs = Date.now();
        loadState();
        initIdentity();
        adoptThreads();
        Favorites.load();
        Mutes.load();

        for (const [key, room] of Object.entries(PUBLIC_ROOMS)) {
            if (!state.publicRoomSecrets[key]) state.publicRoomSecrets[key] = await Crypto.sha256(room.passphrase);
        }

        await seedDefaultRooms();

        let wasOnline = false;
        SkateNostr.onStatus(({ connected }) => {
            const online = connected > 0;
            [...Object.values(state.groups), ...Object.values(state.publicRooms)].forEach(g => { g.connected = online; });
            // relays back: push what could not be sent while they were gone
            if (online && !wasOnline) setTimeout(resendUnsent, 800);
            wasOnline = online;
            notifyUpdate();
        });
        if (!storageHooked) {
            storageHooked = true;
            // another tab of this site saved: fold its messages in (never overwrite them later)
            window.addEventListener('storage', (e) => { if (e.key === CONFIG.STORAGE_KEY && e.newValue && booted) mergeFromOtherTab(e.newValue); });
        }
        SkateNostr.start();

        resubscribe();
        startPresence();

        // Tell the room you're gone the moment the tab closes — kills the
        // "2 online" ghost. pagehide (not visibilitychange) so tab switches
        // don't flicker everyone offline.
        if (!pagehideHooked) {
            pagehideHooked = true;
            window.addEventListener('pagehide', () => { if (booted) sendBye(allGroupIds()); });
            // Back from the background: sockets may be dead-but-open on phones;
            // check them, replay the subscription with a fresh `since`, and
            // say hello again in the room on screen.
            document.addEventListener('visibilitychange', () => {
                if (!booted) return;
                if (document.visibilityState === 'visible') {
                    try { SkateNostr.checkAlive(); } catch {}
                    resubscribe();
                    beatNow();
                } else {
                    const gid = state.viewOpen && !state.activeDmRecipient ? state.activeGroupId : null;
                    if (gid && !isInvisible()) sendBye([gid]);
                }
            });
        }

        notifyUpdate();
    }

    /**
     * v3.8: Settings turned the community off (or the last section that needed
     * the relays). Says goodbye, stops the heartbeat, drops the subscriptions
     * and closes the sockets; init() brings everything back later. The code
     * stays loaded (scripts cannot unload), idle and silent.
     */
    function shutdown({ keepRelays = false } = {}) {
        if (!booted) return;
        sendBye(allGroupIds());
        stopPresence();
        state.callbacks = [];
        try { SkateNostr.unsub('skate-main'); } catch {}
        if (!keepRelays) { try { SkateNostr.stop(); } catch {} }
        booted = false;
        Notify.updateTitle(0);
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
            favoritesCount: Favorites.count(),
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
        init, shutdown, setViewOpen, get booted() { return booted; },
        react, unsend, loadOlder, REACTIONS,
        createGroup, joinPublicRoom, leaveGroup, renameGroup,
        parseInviteHash, acceptInvite, getInviteInfo,
        sendMessage, shareProgram, shareGuide, retryMessage,
        startDm, sendDm, sendDmTo, sendDmImage, importIdentity, resetIdentity, closeDm, openConversation, deleteDmThread, clearHistory,
        getConversations, getRoster,
        setDisplayName, getIdentity,
        onUpdate, getState, getConnectionStatus, getPublicRooms,
        applyPrivacy,
        Notify, Favorites, Crypto, Mutes
    };
})();

// Expose on window like the other modules — ui.js (copyText toasts) and
// refresh.js probe `window.SkateChat?.…`, which silently no-oped while
// this was only a lexical const.
if (typeof window !== 'undefined') window.SkateChat = SkateChat;
if (typeof module !== 'undefined') module.exports = SkateChat;
