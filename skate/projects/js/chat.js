/**
 * SkateChat - Encrypted group chat using Nostr protocol
 * 
 * Features:
 * - NIP-44 encryption (ChaCha20-Poly1305 AEAD)
 * - Nostr ephemeral events for messaging
 * - Group encryption with shared secret
 * - DM support with proper ECDH key derivation
 * - Profanity filtering
 * - Unread DM tracking
 * - Browser & toast notifications
 * - Public rooms for community
 */

const SkateChat = (() => {
    'use strict';
    
    // ========== CONFIG ==========
    const CONFIG = {
        RELAYS: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'],
        EVENT_KINDS: { GROUP_MSG: 20100, DM: 20101, VOTE: 20102, SHARE: 20103, PRESENCE: 20104 },
        MAX_GROUPS: 10,  // Only counts private groups, not public rooms
        MAX_MESSAGES: 500,
        MAX_MESSAGE_LENGTH: 500,
        STORAGE_KEY: 'skate_groups_v6',
        SESSION_KEY: 'skate_session_v6',
        FAVORITES_KEY: 'skate_favorites_v2',
        PUBLIC_ROOMS_KEY: 'skate_public_rooms_v2',
        PRESENCE_INTERVAL: 30000
    };
    
    // Public rooms - secrets will be hashed to proper 64-char hex using SHA-256
    // These are community rooms that don't count toward MAX_GROUPS limit
    const PUBLIC_ROOMS = {
        leisure: { name: 'Leisure Skating', passphrase: 'toronto-leisure-skate-public-2025', emoji: '⛸️', desc: 'Casual skating & fun' },
        shinny: { name: 'Shinny Hockey', passphrase: 'toronto-shinny-hockey-public-2025', emoji: '🏒', desc: 'Drop-in hockey games' },
        figure: { name: 'Figure Skating', passphrase: 'toronto-figure-skate-public-2025', emoji: '⛸️', desc: 'Spins, jumps & grace' },
        general: { name: 'General Chat', passphrase: 'toronto-skating-general-public-2025', emoji: '💬', desc: 'Help, tips & chill' }
    };
    
    const ADJECTIVES = ['Swift', 'Gliding', 'Frozen', 'Quick', 'Cool', 'Icy', 'Smooth', 'Fast', 'Chill', 'Frosty'];
    const NOUNS = ['Skater', 'Penguin', 'Blade', 'Tiger', 'Bear', 'Fox', 'Wolf', 'Hawk', 'Star', 'Flash'];
    
    // ========== STATE ==========
    const state = {
        myName: null,
        mySecretKey: null,
        myPublicKey: null,
        groups: {},           // Private groups only
        publicRooms: {},      // Public rooms (separate, don't count toward limit)
        activeGroupId: null,
        activeIsPublic: false, // Track if active group is a public room
        dmThreads: {},        // pubkey -> { name, groupId, messages[], unread }
        activeDmRecipient: null,
        connections: new Map(),
        callbacks: [],
        presenceTimers: new Map(),
        favorites: new Set(),   // Set of program IDs (hash of activity+location+date)
        publicRoomSecrets: {}  // Cache: roomKey -> 64-char hex secret
    };
    
    // ========== NOTIFICATIONS ==========
    const Notify = {
        // Show browser notification (only if already granted, don't prompt)
        browser(title, body, onClick = null) {
            if (!('Notification' in window)) return;
            if (Notification.permission !== 'granted' || document.hasFocus()) return;
            try {
                const notif = new Notification(title, { 
                    body, 
                    icon: '⛸️',
                    tag: 'skate-chat',
                    silent: false
                });
                if (onClick) notif.onclick = onClick;
                setTimeout(() => notif.close(), 5000);
            } catch (e) { /* ignore */ }
        },
        
        // Show in-app toast
        toast(message, type = 'info', duration = 4000) {
            const container = document.getElementById('toast-container') || this._createContainer();
            const toast = document.createElement('div');
            toast.className = `toast toast-${type}`;
            toast.innerHTML = `<span>${message}</span><button onclick="this.parentElement.remove()">✕</button>`;
            container.appendChild(toast);
            setTimeout(() => toast.classList.add('show'), 10);
            setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, duration);
        },
        
        _createContainer() {
            const c = document.createElement('div');
            c.id = 'toast-container';
            document.body.appendChild(c);
            return c;
        },
        
        // Update page title with unread count
        updateTitle(unread) {
            const base = 'Toronto Skating';
            document.title = unread > 0 ? `(${unread}) ${base}` : base;
        }
    };
    
    // ========== FAVORITES ==========
    const Favorites = {
        load() {
            try {
                const saved = localStorage.getItem(CONFIG.FAVORITES_KEY);
                if (saved) state.favorites = new Set(JSON.parse(saved));
            } catch (e) { console.warn('[Favorites] Load error:', e); }
        },
        
        save() {
            try {
                localStorage.setItem(CONFIG.FAVORITES_KEY, JSON.stringify([...state.favorites]));
            } catch (e) { console.warn('[Favorites] Save error:', e); }
        },
        
        // Generate a unique ID for a program
        getId(program) {
            const activity = program.Activity || program['Activity Title'] || '';
            const location = program.LocationName || program['Location Name'] || '';
            const date = program['Start Date Time'] || program['Start Date'] || '';
            return Crypto.hashSync(`${activity}|${location}|${date}`).slice(0, 16);
        },
        
        toggle(program) {
            const id = this.getId(program);
            if (state.favorites.has(id)) {
                state.favorites.delete(id);
                Notify.toast('Removed from favorites', 'info', 2000);
            } else {
                state.favorites.add(id);
                Notify.toast('Added to favorites ❤️', 'success', 2000);
            }
            this.save();
            return state.favorites.has(id);
        },
        
        has(program) { return state.favorites.has(this.getId(program)); },
        getAll() { return [...state.favorites]; },
        count() { return state.favorites.size; }
    };
    
    // ========== PROFANITY FILTER ==========
    const Filter = {
        check(text) {
            if (!text || typeof window.PROFANITY_LIST === 'undefined') return false;
            const lower = text.toLowerCase();
            return window.PROFANITY_LIST.some(word => {
                const w = word.toLowerCase();
                return lower.includes(w) || lower.split(/\s+/).includes(w);
            });
        },
        
        clean(text) {
            if (!text || typeof window.PROFANITY_LIST === 'undefined') return text;
            let result = text;
            window.PROFANITY_LIST.forEach(word => {
                const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                result = result.replace(regex, '*'.repeat(word.length));
            });
            return result;
        }
    };
    
    // ========== CRYPTO (using NostrTools NIP-44) ==========
    const Crypto = {
        // Generate random bytes as hex
        randomHex(bytes = 32) {
            const arr = new Uint8Array(bytes);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        },
        
        // SHA-256 hash (using SubtleCrypto) - returns 64-char hex
        async sha256(data) {
            const encoder = new TextEncoder();
            const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
            return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        },
        
        // Derive a proper 64-char hex secret from a passphrase using SHA-256
        async deriveSecret(passphrase) {
            return this.sha256(passphrase);
        },
        
        // Synchronous hash for IDs (simpler, still secure enough for IDs)
        hashSync(str) {
            // Use a proper mixing function for group IDs
            let hash = 0x811c9dc5;
            for (let i = 0; i < str.length; i++) {
                hash ^= str.charCodeAt(i);
                hash = Math.imul(hash, 0x01000193);
            }
            // Generate a longer ID by running multiple rounds
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
        
        // NIP-44 encryption using NostrTools (real crypto!)
        // For group messages: we use a shared secret key derived from the group secret
        encryptForGroup(plaintext, groupSecretHex) {
            // Create a deterministic keypair from the group secret for symmetric encryption
            // We use the first 32 bytes as private key, derive pubkey
            const secretBytes = this.hexToBytes(groupSecretHex.slice(0, 64));
            const pubkey = NostrTools.getPublicKey(secretBytes);
            // Use NIP-44 v2 encryption
            const conversationKey = NostrTools.nip44.getConversationKey(secretBytes, pubkey);
            return NostrTools.nip44.encrypt(plaintext, conversationKey);
        },
        
        decryptForGroup(ciphertext, groupSecretHex) {
            try {
                const secretBytes = this.hexToBytes(groupSecretHex.slice(0, 64));
                const pubkey = NostrTools.getPublicKey(secretBytes);
                const conversationKey = NostrTools.nip44.getConversationKey(secretBytes, pubkey);
                return NostrTools.nip44.decrypt(ciphertext, conversationKey);
            } catch (e) { 
                console.warn('[SkateChat] Decrypt error:', e);
                return null; 
            }
        },
        
        // DM encryption using proper ECDH (NIP-44)
        encryptDm(plaintext, senderSecretKey, recipientPubkey) {
            const conversationKey = NostrTools.nip44.getConversationKey(senderSecretKey, recipientPubkey);
            return NostrTools.nip44.encrypt(plaintext, conversationKey);
        },
        
        decryptDm(ciphertext, recipientSecretKey, senderPubkey) {
            try {
                const conversationKey = NostrTools.nip44.getConversationKey(recipientSecretKey, senderPubkey);
                return NostrTools.nip44.decrypt(ciphertext, conversationKey);
            } catch (e) { 
                console.warn('[SkateChat] DM decrypt error:', e);
                return null; 
            }
        },
        
        hexToBytes(hex) {
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            return bytes;
        },
        
        bytesToHex(bytes) { return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''); }
    };
    
    // ========== IDENTITY ==========
    function generateName() {
        return ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] +
               NOUNS[Math.floor(Math.random() * NOUNS.length)] +
               Math.floor(Math.random() * 100);
    }
    
    function initIdentity() {
        if (!state.mySecretKey) {
            state.mySecretKey = NostrTools.generateSecretKey();
            state.myPublicKey = NostrTools.getPublicKey(state.mySecretKey);
        }
        if (!state.myName) state.myName = generateName();
        saveSession();
    }
    
    // ========== STORAGE ==========
    function loadState() {
        try {
            const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (saved) {
                const p = JSON.parse(saved);
                state.groups = p.groups || {};
                state.activeGroupId = p.activeGroupId || null;
                state.activeIsPublic = p.activeIsPublic || false;
                state.dmThreads = p.dmThreads || {};
            }
            // Load public rooms separately
            const publicSaved = localStorage.getItem(CONFIG.PUBLIC_ROOMS_KEY);
            if (publicSaved) {
                const p = JSON.parse(publicSaved);
                state.publicRooms = p.publicRooms || {};
                state.publicRoomSecrets = p.publicRoomSecrets || {};
            }
            const session = sessionStorage.getItem(CONFIG.SESSION_KEY);
            if (session) {
                const p = JSON.parse(session);
                state.myName = p.myName;
                if (p.mySecretKeyHex) {
                    state.mySecretKey = Crypto.hexToBytes(p.mySecretKeyHex);
                    state.myPublicKey = p.myPublicKey;
                }
            }
        } catch (e) { console.error('[SkateChat] Load error:', e); }
    }
    
    function saveState() {
        try {
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
                groups: state.groups,
                activeGroupId: state.activeGroupId,
                activeIsPublic: state.activeIsPublic,
                dmThreads: state.dmThreads
            }));
            // Save public rooms separately
            localStorage.setItem(CONFIG.PUBLIC_ROOMS_KEY, JSON.stringify({
                publicRooms: state.publicRooms,
                publicRoomSecrets: state.publicRoomSecrets
            }));
        } catch (e) { console.error('[SkateChat] Save error:', e); }
    }
    
    function saveSession() {
        try {
            sessionStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify({
                myName: state.myName,
                mySecretKeyHex: state.mySecretKey ? Crypto.bytesToHex(state.mySecretKey) : null,
                myPublicKey: state.myPublicKey
            }));
        } catch (e) { console.error('[SkateChat] Session error:', e); }
    }
    
    // ========== NETWORK ==========
    function getGroupOrRoom(groupId) {
        return state.groups[groupId] || state.publicRooms[groupId] || null;
    }
    
    function connectToRelays(groupId, isPublic = false) {
        const group = isPublic ? state.publicRooms[groupId] : state.groups[groupId];
        if (!group) return;
        disconnectFromRelays(groupId);
        
        const sockets = [];
        for (const url of CONFIG.RELAYS) {
            try {
                const ws = new WebSocket(url);
                ws.onopen = () => {
                    const subId = `skate_${groupId}_${Date.now()}`;
                    ws.send(JSON.stringify(['REQ', subId, {
                        kinds: Object.values(CONFIG.EVENT_KINDS),
                        '#g': [groupId],
                        since: Math.floor(Date.now() / 1000) - 3600
                    }]));
                    ws._subId = subId;
                    group.connected = true;
                    notifyUpdate();
                };
                ws.onmessage = (e) => {
                    try {
                        const data = JSON.parse(e.data);
                        if (data[0] === 'EVENT' && data[2]) handleEvent(groupId, data[2], isPublic);
                    } catch {}
                };
                ws.onclose = () => {
                    const idx = sockets.indexOf(ws);
                    if (idx > -1) sockets.splice(idx, 1);
                    const g = isPublic ? state.publicRooms[groupId] : state.groups[groupId];
                    if (sockets.length === 0 && g) {
                        g.connected = false;
                        notifyUpdate();
                        setTimeout(() => g && connectToRelays(groupId, isPublic), 5000);
                    }
                };
                sockets.push(ws);
            } catch {}
        }
        state.connections.set(groupId, sockets);
    }
    
    function disconnectFromRelays(groupId) {
        const sockets = state.connections.get(groupId);
        if (sockets) {
            sockets.forEach(ws => { try { ws.close(); } catch {} });
            state.connections.delete(groupId);
        }
        const timer = state.presenceTimers.get(groupId);
        if (timer) { clearInterval(timer); state.presenceTimers.delete(groupId); }
    }
    
    function publishEvent(groupId, kind, content, extraTags = []) {
        const group = getGroupOrRoom(groupId);
        if (!group || !state.mySecretKey) return false;
        
        try {
            // Use NIP-44 encryption (ChaCha20-Poly1305)
            const encrypted = Crypto.encryptForGroup(JSON.stringify(content), group.secret);
            const event = NostrTools.finalizeEvent({
                kind,
                content: encrypted,
                tags: [['g', groupId], ...extraTags],
                created_at: Math.floor(Date.now() / 1000)
            }, state.mySecretKey);
            
            const sockets = state.connections.get(groupId);
            if (sockets) {
                sockets.forEach(ws => {
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['EVENT', event]));
                });
            }
            return true;
        } catch (e) { console.error('[SkateChat] Publish error:', e); return false; }
    }
    
    function handleEvent(groupId, event, isPublic = false) {
        const group = isPublic ? state.publicRooms[groupId] : state.groups[groupId];
        if (!group) return;
        if (!group._processedIds) group._processedIds = new Set();
        if (group._processedIds.has(event.id)) return;
        group._processedIds.add(event.id);
        if (group._processedIds.size > 500) group._processedIds = new Set(Array.from(group._processedIds).slice(-250));
        
        try {
            if (!NostrTools.verifyEvent(event)) return;
            // Use NIP-44 decryption (ChaCha20-Poly1305)
            const decrypted = Crypto.decryptForGroup(event.content, group.secret);
            if (!decrypted) return;
            
            const content = JSON.parse(decrypted);
            const isMine = event.pubkey === state.myPublicKey;
            
            switch (event.kind) {
                case CONFIG.EVENT_KINDS.GROUP_MSG:
                    addMessage(groupId, {
                        id: event.id, type: 'chat', text: Filter.clean(content.text),
                        from: content.from, fromPubkey: event.pubkey, mine: isMine,
                        system: content.system, ts: event.created_at * 1000
                    });
                    trackMember(groupId, content.from, event.pubkey);
                    // Notify for non-system messages from others
                    if (!isMine && !content.system) {
                        Notify.browser(`${content.from} in ${group.name || 'Group'}`, content.text);
                        if (state.activeGroupId !== groupId) {
                            Notify.toast(`💬 ${content.from}: ${content.text.slice(0, 50)}...`, 'info');
                        }
                    }
                    break;
                    
                case CONFIG.EVENT_KINDS.SHARE:
                    addMessage(groupId, {
                        id: event.id, type: 'share', text: content.text,
                        from: content.from, fromPubkey: event.pubkey, mine: isMine,
                        ts: event.created_at * 1000, data: content.data
                    });
                    // Notify for shares from others
                    if (!isMine) {
                        Notify.browser(`${content.from} shared a program`, content.data?.activity || 'Skating program');
                    }
                    trackMember(groupId, content.from, event.pubkey);
                    break;
                    
                case CONFIG.EVENT_KINDS.VOTE:
                    if (!group.votes) group.votes = {};
                    const idx = content.programIndex;
                    if (!group.votes[idx]) group.votes[idx] = [];
                    if (content.voted && !group.votes[idx].includes(content.from)) {
                        group.votes[idx].push(content.from);
                    } else if (!content.voted) {
                        const i = group.votes[idx].indexOf(content.from);
                        if (i > -1) group.votes[idx].splice(i, 1);
                    }
                    break;
                    
                case CONFIG.EVENT_KINDS.DM:
                    handleDmEvent(groupId, event, content);
                    break;
                    
                case CONFIG.EVENT_KINDS.PRESENCE:
                    trackMember(groupId, content.from, event.pubkey);
                    if (!group.lastSeen) group.lastSeen = {};
                    group.lastSeen[content.from] = event.created_at * 1000; 
                    break;
            }
            
            saveState();
            notifyUpdate();
        } catch (e) { console.warn('[SkateChat] Event error:', e); }
    }
    
    function trackMember(groupId, name, pubkey) {
        const group = getGroupOrRoom(groupId);
        if (!group) return;
        if (!group.members.includes(name)) group.members.push(name);
        if (!group.memberPubkeys) group.memberPubkeys = {};
        group.memberPubkeys[name] = pubkey;
    }
    
    function handleDmEvent(groupId, event, content) {
        const toTag = event.tags.find(t => t[0] === 'p');
        if (!toTag) return;
        
        const recipientPubkey = toTag[1];
        const isForMe = recipientPubkey === state.myPublicKey;
        const isFromMe = event.pubkey === state.myPublicKey;
        if (!isForMe && !isFromMe) return;
        
        // DMs use proper NIP-44 ECDH encryption
        // If it's for me, decrypt with my secret key + sender's pubkey
        // If it's from me, decrypt with my secret key + recipient's pubkey
        let dmContent;
        if (isForMe) {
            dmContent = Crypto.decryptDm(content.dmPayload, state.mySecretKey, event.pubkey);
        } else {
            dmContent = Crypto.decryptDm(content.dmPayload, state.mySecretKey, recipientPubkey);
        }
        if (!dmContent) return;
        
        const dmData = JSON.parse(dmContent);
        const otherPubkey = isFromMe ? recipientPubkey : event.pubkey;
        
        if (!state.dmThreads[otherPubkey]) {
            state.dmThreads[otherPubkey] = {
                groupId, name: isFromMe ? content.toName : content.from,
                messages: [], unread: 0
            };
        }
        
        const thread = state.dmThreads[otherPubkey];
        if (!thread.messages.some(m => m.id === event.id)) {
            thread.messages.push({
                id: event.id, text: Filter.clean(dmData.text),
                from: content.from, mine: isFromMe, ts: event.created_at * 1000
            });
            if (thread.messages.length > 50) thread.messages = thread.messages.slice(-50);
            thread.messages.sort((a, b) => a.ts - b.ts);
            
            // Track unread if not viewing this DM
            if (!isFromMe && state.activeDmRecipient !== otherPubkey) {
                thread.unread = (thread.unread || 0) + 1;
                // Notify for DMs
                Notify.browser(`DM from ${content.from}`, dmData.text);
                Notify.toast(`📩 ${content.from}: ${dmData.text.slice(0, 40)}...`, 'info');
            }
        }
    }
    
    function addMessage(groupId, msg) {
        const group = getGroupOrRoom(groupId);
        if (!group || group.messages.some(m => m.id === msg.id)) return;
        group.messages.push(msg);
        if (group.messages.length > CONFIG.MAX_MESSAGES) group.messages = group.messages.slice(-CONFIG.MAX_MESSAGES);
        group.messages.sort((a, b) => a.ts - b.ts);
        
        // Track unread if not my message and not viewing this group
        if (!msg.mine && !msg.system && state.activeGroupId !== groupId) {
            group.unread = (group.unread || 0) + 1;
        }
    }
    
    function startPresence(groupId) {
        publishEvent(groupId, CONFIG.EVENT_KINDS.PRESENCE, { from: state.myName, status: 'online' });
        const timer = setInterval(() => {
            if (getGroupOrRoom(groupId)) publishEvent(groupId, CONFIG.EVENT_KINDS.PRESENCE, { from: state.myName, status: 'online' });
        }, CONFIG.PRESENCE_INTERVAL);
        state.presenceTimers.set(groupId, timer);
    }
    
    function notifyUpdate() {
        const s = getState();
        state.callbacks.forEach(cb => { try { cb(s); } catch {} });
    }
    
    // ========== PUBLIC API ==========
    async function init() {
        if (typeof NostrTools === 'undefined') { console.error('[SkateChat] NostrTools not loaded!'); return; }
        loadState();
        initIdentity();
        Favorites.load();
        
        // Pre-compute public room secrets using SHA-256
        for (const [key, room] of Object.entries(PUBLIC_ROOMS)) {
            if (!state.publicRoomSecrets[key]) {
                state.publicRoomSecrets[key] = await Crypto.deriveSecret(room.passphrase);
            }
        }
        
        const hash = window.location.hash.slice(1);
        if (hash && hash.length >= 32) {
            const groupId = Crypto.deriveGroupId(hash);
            if (!state.groups[groupId]) await joinGroup(hash);
            else state.activeGroupId = groupId;
        }
        
        // Connect to private groups
        for (const gid of Object.keys(state.groups)) {
            connectToRelays(gid, false);
            startPresence(gid);
        }
        
        // Connect to any previously joined public rooms
        for (const gid of Object.keys(state.publicRooms)) {
            connectToRelays(gid, true);
            startPresence(gid);
        }
        
        console.log('[SkateChat] Initialized with NIP-44 encryption (ChaCha20-Poly1305)');
        notifyUpdate();
    }
    
    async function joinPublicRoom(roomKey) {
        const room = PUBLIC_ROOMS[roomKey];
        if (!room) throw new Error('Unknown room');
        
        // Ensure we have the SHA-256 derived secret
        if (!state.publicRoomSecrets[roomKey]) {
            state.publicRoomSecrets[roomKey] = await Crypto.deriveSecret(room.passphrase);
        }
        const secret = state.publicRoomSecrets[roomKey];
        const groupId = Crypto.deriveGroupId(secret);
        
        // Check if already in this public room
        if (state.publicRooms[groupId]) {
            state.activeGroupId = groupId;
            state.activeIsPublic = true;
            saveState(); 
            notifyUpdate();
            Notify.toast(`Switched to ${room.name}`, 'info', 2000);
            return { groupId, alreadyJoined: true };
        }
        
        // Create public room entry (no join announcement, no limit check)
        state.publicRooms[groupId] = {
            id: groupId, 
            name: room.name, 
            secret: secret,
            emoji: room.emoji,
            isPublic: true,
            roomKey: roomKey,
            members: [state.myName], 
            memberPubkeys: { [state.myName]: state.myPublicKey },
            messages: [], 
            votes: {}, 
            connected: false, 
            createdAt: Date.now()
        };
        
        state.activeGroupId = groupId;
        state.activeIsPublic = true;
        saveState();
        connectToRelays(groupId, true);
        startPresence(groupId);
        
        Notify.toast(`Joined ${room.name}! ⛸️`, 'success');
        notifyUpdate();
        return { groupId };
    }
    
    async function createGroup(options = {}) {
        // Only private groups count toward limit
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) throw new Error(`Max ${CONFIG.MAX_GROUPS} private groups`);
        
        const name = options.name || 'Skating Group';
        if (Filter.check(name)) throw new Error('Group name contains inappropriate content');
        
        // Use SHA-256 for password hashing, random hex for no password
        const secret = options.password ? await Crypto.sha256(options.password) : Crypto.randomHex(32);
        const groupId = Crypto.deriveGroupId(secret);
        
        if (state.groups[groupId]) {
            state.activeGroupId = groupId;
            state.activeIsPublic = false;
            saveState(); notifyUpdate();
            return { groupId, shareUrl: getShareUrl(), exists: true };
        }
        
        state.groups[groupId] = {
            id: groupId, name, secret, hasPassword: !!options.password,
            members: [state.myName], memberPubkeys: { [state.myName]: state.myPublicKey },
            messages: [], votes: {}, connected: false, createdAt: Date.now()
        };
        
        state.activeGroupId = groupId;
        state.activeIsPublic = false;
        saveState();
        connectToRelays(groupId, false);
        
        setTimeout(() => {
            publishEvent(groupId, CONFIG.EVENT_KINDS.GROUP_MSG, { text: `${state.myName} created the group`, from: state.myName, system: true });
            startPresence(groupId);
        }, 1000);
        
        notifyUpdate();
        return { groupId, shareUrl: getShareUrl() };
    }
    
    async function joinGroup(secret, password = null, customName = null) {
        // Only private groups count toward limit
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) throw new Error(`Max ${CONFIG.MAX_GROUPS} private groups`);
        
        // Ensure we have a proper 64-char hex secret
        let actualSecret;
        if (password) {
            // If password provided, hash it to get a proper secret
            actualSecret = await Crypto.sha256(password);
        } else if (secret.length === 64 && /^[0-9a-f]+$/i.test(secret)) {
            // Already a valid 64-char hex secret
            actualSecret = secret.toLowerCase();
        } else {
            // Hash the secret to normalize it to 64-char hex
            actualSecret = await Crypto.sha256(secret);
        }
        
        const groupId = Crypto.deriveGroupId(actualSecret);
        
        if (state.groups[groupId]) {
            state.activeGroupId = groupId;
            state.activeIsPublic = false;
            saveState(); notifyUpdate();
            Notify.toast(`Switched to ${state.groups[groupId].name}`, 'info', 2000);
            return { groupId, alreadyJoined: true };
        }
        
        const groupName = customName || 'Skating Group';
        state.groups[groupId] = {
            id: groupId, name: groupName, secret: actualSecret, hasPassword: !!password,
            members: [state.myName], memberPubkeys: { [state.myName]: state.myPublicKey },
            messages: [], votes: {}, connected: false, createdAt: Date.now()
        };
        
        state.activeGroupId = groupId;
        state.activeIsPublic = false;
        saveState();
        connectToRelays(groupId, false);
        
        setTimeout(() => {
            publishEvent(groupId, CONFIG.EVENT_KINDS.GROUP_MSG, { text: `${state.myName} joined the group`, from: state.myName, system: true });
            startPresence(groupId);
        }, 1000);
        
        Notify.toast(`Joined ${groupName}! 🎉`, 'success');
        notifyUpdate();
        return { groupId };
    }
    
    function leaveGroup(groupId) {
        // Check if it's a public room or private group
        const isPublic = !!state.publicRooms[groupId];
        const group = isPublic ? state.publicRooms[groupId] : state.groups[groupId];
        if (!group) return;
        
        // Only announce leaving for private groups
        if (!isPublic) {
            publishEvent(groupId, CONFIG.EVENT_KINDS.GROUP_MSG, { text: `${state.myName} left the group`, from: state.myName, system: true });
        }
        
        disconnectFromRelays(groupId);
        
        if (isPublic) {
            delete state.publicRooms[groupId];
        } else {
            delete state.groups[groupId];
        }
        
        if (state.activeGroupId === groupId) {
            // Switch to another group, preferring private ones
            const nextPrivate = Object.keys(state.groups)[0];
            const nextPublic = Object.keys(state.publicRooms)[0];
            state.activeGroupId = nextPrivate || nextPublic || null;
            state.activeIsPublic = !nextPrivate && !!nextPublic;
        }
        saveState(); 
        notifyUpdate();
    }
    
    function switchGroup(groupId) {
        // Check both private and public
        if (state.groups[groupId]) {
            state.activeGroupId = groupId;
            state.activeIsPublic = false;
            state.activeDmRecipient = null;
            state.groups[groupId].unread = 0; // Clear unread
            saveState(); notifyUpdate();
        } else if (state.publicRooms[groupId]) {
            state.activeGroupId = groupId;
            state.activeIsPublic = true;
            state.activeDmRecipient = null;
            state.publicRooms[groupId].unread = 0; // Clear unread
            saveState(); notifyUpdate();
        }
    }
    
    function sendMessage(text) {
        if (!state.activeGroupId || !text.trim()) return false;
        if (Filter.check(text)) return false; // Block profane messages
        const trimmed = text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);
        return publishEvent(state.activeGroupId, CONFIG.EVENT_KINDS.GROUP_MSG, { text: trimmed, from: state.myName });
    }
    
    function shareProgram(program) {
        if (!state.activeGroupId) return false;
        const activity = program.Activity || program['Activity Title'] || 'Unknown';
        const location = program.LocationName || program['Location Name'] || '';
        const dateStr = program['Start Date Time'] || program['Start Date'] || '';
        const time = program['Start Time'] || '';
        const endTime = program['End Time'] || '';
        
        // Format date nicely
        let dateDisplay = '';
        if (dateStr) {
            const d = new Date(dateStr);
            dateDisplay = d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
        }
        
        return publishEvent(state.activeGroupId, CONFIG.EVENT_KINDS.SHARE, {
            text: `⛸️ ${activity}`,
            from: state.myName,
            data: { activity, location, date: dateDisplay, time, endTime }
        });
    }
    
    function voteTime(programIndex) {
        const group = getGroupOrRoom(state.activeGroupId);
        if (!group) return false;
        if (!group.votes) group.votes = {};
        if (!group.votes[programIndex]) group.votes[programIndex] = [];
        
        const idx = group.votes[programIndex].indexOf(state.myName);
        const voted = idx === -1;
        if (voted) group.votes[programIndex].push(state.myName);
        else group.votes[programIndex].splice(idx, 1);
        
        saveState(); notifyUpdate();
        return publishEvent(state.activeGroupId, CONFIG.EVENT_KINDS.VOTE, { programIndex, from: state.myName, voted });
    }
    
    function startDm(memberName) {
        const group = getGroupOrRoom(state.activeGroupId);
        if (!group?.memberPubkeys) return false;
        const recipientPubkey = group.memberPubkeys[memberName];
        if (!recipientPubkey || recipientPubkey === state.myPublicKey) return false;
        
        if (!state.dmThreads[recipientPubkey]) {
            state.dmThreads[recipientPubkey] = { groupId: state.activeGroupId, name: memberName, messages: [], unread: 0 };
        }
        
        state.dmThreads[recipientPubkey].unread = 0; // Mark as read
        state.activeDmRecipient = recipientPubkey;
        saveState(); notifyUpdate();
        return true;
    }
    
    function sendDm(text) {
        if (!state.activeDmRecipient || !state.activeGroupId || !text.trim()) return false;
        if (Filter.check(text)) return false;
        
        const group = getGroupOrRoom(state.activeGroupId);
        const thread = state.dmThreads[state.activeDmRecipient];
        if (!group || !thread) return false;
        
        const trimmed = text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);
        // Use proper NIP-44 ECDH encryption for DMs
        const dmPayload = Crypto.encryptDm(JSON.stringify({ text: trimmed }), state.mySecretKey, state.activeDmRecipient);
        
        return publishEvent(state.activeGroupId, CONFIG.EVENT_KINDS.DM, {
            from: state.myName, toName: thread.name, dmPayload
        }, [['p', state.activeDmRecipient]]);
    }
    
    function closeDm() { state.activeDmRecipient = null; notifyUpdate(); }
    
    function onUpdate(callback) { state.callbacks.push(callback); callback(getState()); }
    
    function getState() {
        // Get active group from either private or public
        const activeGroup = state.activeIsPublic 
            ? state.publicRooms[state.activeGroupId] 
            : state.groups[state.activeGroupId] || null;
        const activeDmThread = state.activeDmRecipient ? state.dmThreads[state.activeDmRecipient] : null;
        
        // Count total unread DMs
        let totalDmUnread = 0;
        Object.values(state.dmThreads).forEach(t => { totalDmUnread += t.unread || 0; });
        
        // Count total unread group messages (both private and public)
        let totalGroupUnread = 0;
        Object.values(state.groups).forEach(g => { totalGroupUnread += g.unread || 0; });
        Object.values(state.publicRooms).forEach(g => { totalGroupUnread += g.unread || 0; });
        
        // Update page title with total unread count
        Notify.updateTitle(totalDmUnread + totalGroupUnread);
        
        // Combine all groups for the UI (so it can display both)
        const allGroups = { ...state.groups, ...state.publicRooms };
        
        return {
            myName: state.myName,
            myPublicKey: state.myPublicKey,
            groups: allGroups,
            privateGroups: state.groups,
            publicRooms: state.publicRooms,
            activeGroupId: state.activeGroupId,
            activeIsPublic: state.activeIsPublic,
            activeGroup,
            dmThreads: state.dmThreads,
            activeDmRecipient: state.activeDmRecipient,
            activeDmThread,
            totalDmUnread,
            totalGroupUnread,
            viewMode: state.activeDmRecipient ? 'dm' : 'group',
            favoritesCount: state.favorites.size,
            publicRoomSecrets: state.publicRoomSecrets
        };
    }
    
    function getShareUrl() {
        // Only share private groups (not public rooms)
        const group = state.groups[state.activeGroupId];
        return group ? `${window.location.origin}${window.location.pathname}#${group.secret}` : null;
    }
    
    function getConnectionStatus(groupId = null) {
        const group = getGroupOrRoom(groupId || state.activeGroupId);
        return group?.connected ? 'connected' : 'disconnected';
    }
    
    function getDmThreadsList() {
        return Object.entries(state.dmThreads).map(([pubkey, thread]) => ({
            pubkey, name: thread.name, unread: thread.unread || 0,
            lastMessage: thread.messages[thread.messages.length - 1] || null
        })).sort((a, b) => (b.lastMessage?.ts || 0) - (a.lastMessage?.ts || 0));
    }
    
    function getPublicRooms() { return PUBLIC_ROOMS; }
    
    return {
        init, createGroup, joinGroup, joinPublicRoom, leaveGroup, switchGroup,
        sendMessage, shareProgram, voteTime,
        startDm, sendDm, closeDm, getDmThreadsList,
        onUpdate, getState, getShareUrl, getConnectionStatus, getPublicRooms,
        Notify, Favorites, Crypto, Filter
    };
})();
