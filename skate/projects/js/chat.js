/**
 * SkateChat - Encrypted group chat using Nostr protocol
 * 
 * Architecture:
 * - Uses Nostr ephemeral events (kind 20000-29999) for messages
 * - Group secret in URL hash = shared symmetric key
 * - Simple XOR + base64 encryption (works across all clients)
 * - DMs use derived keys from group secret + recipient pubkey
 */

const SkateChat = (() => {
    'use strict';
    
    // ========== CONFIGURATION ==========
    const CONFIG = {
        RELAYS: [
            'wss://relay.damus.io',
            'wss://nos.lol', 
            'wss://relay.nostr.band'
        ],
        EVENT_KINDS: {
            GROUP_MSG: 20100,
            DM: 20101,
            VOTE: 20102,
            SHARE: 20103,
            PRESENCE: 20104
        },
        MAX_GROUPS: 5,
        MAX_MESSAGES: 100,
        MAX_MESSAGE_LENGTH: 500,
        STORAGE_KEY: 'skate_groups_v2',
        SESSION_KEY: 'skate_session_v2',
        PRESENCE_INTERVAL: 30000 // 30 seconds
    };
    
    const ADJECTIVES = ['Swift', 'Gliding', 'Frozen', 'Quick', 'Cool', 'Icy', 'Smooth', 'Fast', 'Chill', 'Frosty'];
    const NOUNS = ['Skater', 'Penguin', 'Blade', 'Tiger', 'Bear', 'Fox', 'Wolf', 'Hawk', 'Star', 'Flash'];
    
    // ========== STATE ==========
    const state = {
        myName: null,
        mySecretKey: null,
        myPublicKey: null,
        groups: {},           // groupId -> group data
        activeGroupId: null,
        dmThreads: {},        // recipientPubkey -> messages[]
        activeDmRecipient: null,
        connections: new Map(), // groupId -> WebSocket[]
        callbacks: [],
        presenceTimers: new Map()
    };
    
    // ========== CRYPTO HELPERS ==========
    // These are reusable for both group and DM encryption
    
    const Crypto = {
        /**
         * Generate a random 32-byte hex string
         */
        randomHex(bytes = 32) {
            const arr = new Uint8Array(bytes);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        },
        
        /**
         * Simple hash function for strings -> hex
         */
        hash(str) {
            let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
            for (let i = 0; i < str.length; i++) {
                const ch = str.charCodeAt(i);
                h1 = Math.imul(h1 ^ ch, 2654435761);
                h2 = Math.imul(h2 ^ ch, 1597334677);
            }
            h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
            h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
            h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
            h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
            
            const result = (h2 >>> 0).toString(16).padStart(8, '0') + 
                          (h1 >>> 0).toString(16).padStart(8, '0');
            return result.repeat(4); // 64 chars
        },
        
        /**
         * Derive a key from group secret + optional salt
         */
        deriveKey(secret, salt = '') {
            return this.hash(secret + salt);
        },
        
        /**
         * Derive group ID from secret
         */
        deriveGroupId(secret) {
            return this.hash(secret).slice(0, 12);
        },
        
        /**
         * Derive DM key from group secret + both pubkeys
         */
        deriveDmKey(groupSecret, myPubkey, theirPubkey) {
            // Sort pubkeys for consistent key regardless of direction
            const sorted = [myPubkey, theirPubkey].sort().join('');
            return this.hash(groupSecret + sorted);
        },
        
        /**
         * Encrypt message with key (XOR-based, simple but works)
         */
        encrypt(plaintext, keyHex) {
            const keyBytes = this.hexToBytes(keyHex);
            const textBytes = new TextEncoder().encode(plaintext);
            const encrypted = new Uint8Array(textBytes.length);
            
            for (let i = 0; i < textBytes.length; i++) {
                encrypted[i] = textBytes[i] ^ keyBytes[i % keyBytes.length];
            }
            
            return btoa(String.fromCharCode(...encrypted));
        },
        
        /**
         * Decrypt message with key
         */
        decrypt(ciphertext, keyHex) {
            try {
                const keyBytes = this.hexToBytes(keyHex);
                const encrypted = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
                const decrypted = new Uint8Array(encrypted.length);
                
                for (let i = 0; i < encrypted.length; i++) {
                    decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
                }
                
                return new TextDecoder().decode(decrypted);
            } catch (e) {
                console.warn('[Crypto] Decrypt failed:', e);
                return null;
            }
        },
        
        hexToBytes(hex) {
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) {
                bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            }
            return bytes;
        },
        
        bytesToHex(bytes) {
            return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        }
    };
    
    // ========== IDENTITY ==========
    function generateName() {
        const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
        const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
        const num = Math.floor(Math.random() * 100);
        return `${adj}${noun}${num}`;
    }
    
    function initIdentity() {
        if (!state.mySecretKey) {
            state.mySecretKey = NostrTools.generateSecretKey();
            state.myPublicKey = NostrTools.getPublicKey(state.mySecretKey);
        }
        if (!state.myName) {
            state.myName = generateName();
        }
        saveSession();
    }
    
    // ========== STORAGE ==========
    function loadState() {
        try {
            const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                state.groups = parsed.groups || {};
                state.activeGroupId = parsed.activeGroupId || null;
                state.dmThreads = parsed.dmThreads || {};
            }
            
            const session = sessionStorage.getItem(CONFIG.SESSION_KEY);
            if (session) {
                const parsed = JSON.parse(session);
                state.myName = parsed.myName;
                if (parsed.mySecretKeyHex) {
                    state.mySecretKey = Crypto.hexToBytes(parsed.mySecretKeyHex);
                    state.myPublicKey = parsed.myPublicKey;
                }
            }
        } catch (e) {
            console.error('[SkateChat] Load error:', e);
        }
    }
    
    function saveState() {
        try {
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
                groups: state.groups,
                activeGroupId: state.activeGroupId,
                dmThreads: state.dmThreads
            }));
        } catch (e) {
            console.error('[SkateChat] Save error:', e);
        }
    }
    
    function saveSession() {
        try {
            sessionStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify({
                myName: state.myName,
                mySecretKeyHex: state.mySecretKey ? Crypto.bytesToHex(state.mySecretKey) : null,
                myPublicKey: state.myPublicKey
            }));
        } catch (e) {
            console.error('[SkateChat] Session save error:', e);
        }
    }
    
    // ========== NETWORK ==========
    function connectToRelays(groupId) {
        const group = state.groups[groupId];
        if (!group) return;
        
        disconnectFromRelays(groupId);
        
        const sockets = [];
        
        for (const url of CONFIG.RELAYS) {
            try {
                const ws = new WebSocket(url);
                
                ws.onopen = () => {
                    console.log(`[SkateChat] Connected to ${url}`);
                    
                    // Subscribe to group events
                    const subId = `skate_${groupId}_${Date.now()}`;
                    const filter = {
                        kinds: Object.values(CONFIG.EVENT_KINDS),
                        '#g': [groupId],
                        since: Math.floor(Date.now() / 1000) - 3600
                    };
                    
                    ws.send(JSON.stringify(['REQ', subId, filter]));
                    ws._subId = subId;
                    
                    group.connected = true;
                    notifyUpdate();
                };
                
                ws.onmessage = (e) => {
                    try {
                        const data = JSON.parse(e.data);
                        if (data[0] === 'EVENT' && data[2]) {
                            handleEvent(groupId, data[2]);
                        }
                    } catch (err) {
                        // Ignore parse errors
                    }
                };
                
                ws.onerror = () => {
                    console.warn(`[SkateChat] Error on ${url}`);
                };
                
                ws.onclose = () => {
                    console.log(`[SkateChat] Disconnected from ${url}`);
                    // Remove from list
                    const idx = sockets.indexOf(ws);
                    if (idx > -1) sockets.splice(idx, 1);
                    
                    // Check if all disconnected
                    if (sockets.length === 0 && state.groups[groupId]) {
                        state.groups[groupId].connected = false;
                        notifyUpdate();
                        // Try reconnect after delay
                        setTimeout(() => {
                            if (state.groups[groupId]) connectToRelays(groupId);
                        }, 5000);
                    }
                };
                
                sockets.push(ws);
            } catch (e) {
                console.error(`[SkateChat] Failed to connect to ${url}:`, e);
            }
        }
        
        state.connections.set(groupId, sockets);
    }
    
    function disconnectFromRelays(groupId) {
        const sockets = state.connections.get(groupId);
        if (sockets) {
            for (const ws of sockets) {
                try {
                    if (ws._subId) {
                        ws.send(JSON.stringify(['CLOSE', ws._subId]));
                    }
                    ws.close();
                } catch (e) {
                    // Ignore
                }
            }
            state.connections.delete(groupId);
        }
        
        // Clear presence timer
        const timer = state.presenceTimers.get(groupId);
        if (timer) {
            clearInterval(timer);
            state.presenceTimers.delete(groupId);
        }
    }
    
    function publishEvent(groupId, kind, content, extraTags = []) {
        const group = state.groups[groupId];
        if (!group || !state.mySecretKey) return false;
        
        try {
            // Encrypt content
            const key = Crypto.deriveKey(group.secret);
            const encrypted = Crypto.encrypt(JSON.stringify(content), key);
            
            // Create event
            const event = {
                kind,
                content: encrypted,
                tags: [['g', groupId], ...extraTags],
                created_at: Math.floor(Date.now() / 1000)
            };
            
            const signedEvent = NostrTools.finalizeEvent(event, state.mySecretKey);
            
            // Publish to all connected relays
            const sockets = state.connections.get(groupId);
            if (sockets) {
                for (const ws of sockets) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(['EVENT', signedEvent]));
                    }
                }
            }
            
            console.log('[SkateChat] Published event', kind);
            return true;
        } catch (e) {
            console.error('[SkateChat] Publish error:', e);
            return false;
        }
    }
    
    function handleEvent(groupId, event) {
        const group = state.groups[groupId];
        if (!group) return;
        
        // Skip if already processed
        if (group._processedIds?.has(event.id)) return;
        if (!group._processedIds) group._processedIds = new Set();
        group._processedIds.add(event.id);
        
        // Limit processed IDs memory
        if (group._processedIds.size > 500) {
            const arr = Array.from(group._processedIds);
            group._processedIds = new Set(arr.slice(-250));
        }
        
        try {
            // Verify signature
            if (!NostrTools.verifyEvent(event)) {
                console.warn('[SkateChat] Invalid signature');
                return;
            }
            
            // Decrypt
            const key = Crypto.deriveKey(group.secret);
            const decrypted = Crypto.decrypt(event.content, key);
            if (!decrypted) {
                console.warn('[SkateChat] Decrypt failed');
                return;
            }
            
            const content = JSON.parse(decrypted);
            const isMine = event.pubkey === state.myPublicKey;
            
            switch (event.kind) {
                case CONFIG.EVENT_KINDS.GROUP_MSG:
                    addMessage(groupId, {
                        id: event.id,
                        type: 'chat',
                        text: content.text,
                        from: content.from,
                        fromPubkey: event.pubkey,
                        mine: isMine,
                        ts: event.created_at * 1000
                    });
                    
                    // Track member
                    if (content.from && !group.members.includes(content.from)) {
                        group.members.push(content.from);
                    }
                    // Track pubkey mapping
                    if (!group.memberPubkeys) group.memberPubkeys = {};
                    group.memberPubkeys[content.from] = event.pubkey;
                    break;
                    
                case CONFIG.EVENT_KINDS.SHARE:
                    addMessage(groupId, {
                        id: event.id,
                        type: 'share',
                        text: content.text,
                        from: content.from,
                        fromPubkey: event.pubkey,
                        mine: isMine,
                        ts: event.created_at * 1000,
                        data: content.data
                    });
                    break;
                    
                case CONFIG.EVENT_KINDS.VOTE:
                    if (!group.votes) group.votes = {};
                    const progIdx = content.programIndex;
                    if (!group.votes[progIdx]) group.votes[progIdx] = [];
                    
                    if (content.voted && !group.votes[progIdx].includes(content.from)) {
                        group.votes[progIdx].push(content.from);
                    } else if (!content.voted) {
                        const idx = group.votes[progIdx].indexOf(content.from);
                        if (idx > -1) group.votes[progIdx].splice(idx, 1);
                    }
                    break;
                    
                case CONFIG.EVENT_KINDS.DM:
                    handleDmEvent(groupId, event, content);
                    break;
                    
                case CONFIG.EVENT_KINDS.PRESENCE:
                    // Track member presence
                    if (content.from && !group.members.includes(content.from)) {
                        group.members.push(content.from);
                    }
                    if (!group.memberPubkeys) group.memberPubkeys = {};
                    group.memberPubkeys[content.from] = event.pubkey;
                    if (!group.lastSeen) group.lastSeen = {};
                    group.lastSeen[content.from] = event.created_at * 1000;
                    break;
            }
            
            saveState();
            notifyUpdate();
            
        } catch (e) {
            console.warn('[SkateChat] Handle event error:', e);
        }
    }
    
    function handleDmEvent(groupId, event, content) {
        // Check if DM is for us
        const toTag = event.tags.find(t => t[0] === 'p');
        if (!toTag) return;
        
        const recipientPubkey = toTag[1];
        const isForMe = recipientPubkey === state.myPublicKey;
        const isFromMe = event.pubkey === state.myPublicKey;
        
        if (!isForMe && !isFromMe) return;
        
        // Decrypt DM content with derived key
        const group = state.groups[groupId];
        const dmKey = Crypto.deriveDmKey(group.secret, event.pubkey, recipientPubkey);
        const dmContent = Crypto.decrypt(content.dmPayload, dmKey);
        if (!dmContent) return;
        
        const dmData = JSON.parse(dmContent);
        
        // Store in DM thread
        const otherPubkey = isFromMe ? recipientPubkey : event.pubkey;
        if (!state.dmThreads[otherPubkey]) {
            state.dmThreads[otherPubkey] = {
                groupId,
                name: isFromMe ? content.toName : content.from,
                messages: []
            };
        }
        
        const thread = state.dmThreads[otherPubkey];
        if (!thread.messages.some(m => m.id === event.id)) {
            thread.messages.push({
                id: event.id,
                text: dmData.text,
                from: content.from,
                mine: isFromMe,
                ts: event.created_at * 1000
            });
            
            // Limit size
            if (thread.messages.length > 50) {
                thread.messages = thread.messages.slice(-50);
            }
            
            thread.messages.sort((a, b) => a.ts - b.ts);
        }
    }
    
    function addMessage(groupId, msg) {
        const group = state.groups[groupId];
        if (!group) return;
        
        if (!group.messages.some(m => m.id === msg.id)) {
            group.messages.push(msg);
            
            if (group.messages.length > CONFIG.MAX_MESSAGES) {
                group.messages = group.messages.slice(-CONFIG.MAX_MESSAGES);
            }
            
            group.messages.sort((a, b) => a.ts - b.ts);
        }
    }
    
    function startPresence(groupId) {
        // Send presence immediately
        publishEvent(groupId, CONFIG.EVENT_KINDS.PRESENCE, {
            from: state.myName,
            status: 'online'
        });
        
        // Then periodically
        const timer = setInterval(() => {
            if (state.groups[groupId]) {
                publishEvent(groupId, CONFIG.EVENT_KINDS.PRESENCE, {
                    from: state.myName,
                    status: 'online'
                });
            }
        }, CONFIG.PRESENCE_INTERVAL);
        
        state.presenceTimers.set(groupId, timer);
    }
    
    // ========== NOTIFICATIONS ==========
    function notifyUpdate() {
        const currentState = getState();
        for (const cb of state.callbacks) {
            try { cb(currentState); } catch (e) { console.error(e); }
        }
    }
    
    // ========== PUBLIC API ==========
    
    function init() {
        if (typeof NostrTools === 'undefined') {
            console.error('[SkateChat] NostrTools not loaded!');
            return;
        }
        
        loadState();
        initIdentity();
        
        // Check URL for group join
        const hash = window.location.hash.slice(1);
        if (hash && hash.length >= 32) {
            const groupId = Crypto.deriveGroupId(hash);
            if (!state.groups[groupId]) {
                joinGroup(hash);
            } else {
                state.activeGroupId = groupId;
            }
        }
        
        // Connect to existing groups
        for (const groupId of Object.keys(state.groups)) {
            connectToRelays(groupId);
            startPresence(groupId);
        }
        
        console.log('[SkateChat] Initialized');
        notifyUpdate();
    }
    
    function createGroup(options = {}) {
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) {
            throw new Error(`Maximum ${CONFIG.MAX_GROUPS} groups`);
        }
        
        const secret = options.password 
            ? Crypto.hash(options.password) 
            : Crypto.randomHex(32);
        const groupId = Crypto.deriveGroupId(secret);
        
        if (state.groups[groupId]) {
            state.activeGroupId = groupId;
            saveState();
            notifyUpdate();
            return { groupId, shareUrl: getShareUrl(), exists: true };
        }
        
        state.groups[groupId] = {
            id: groupId,
            name: options.name || 'Skating Group',
            secret,
            hasPassword: !!options.password,
            members: [state.myName],
            memberPubkeys: { [state.myName]: state.myPublicKey },
            messages: [],
            votes: {},
            connected: false,
            createdAt: Date.now()
        };
        
        state.activeGroupId = groupId;
        saveState();
        
        connectToRelays(groupId);
        
        // Wait a moment for connection, then announce
        setTimeout(() => {
            publishEvent(groupId, CONFIG.EVENT_KINDS.GROUP_MSG, {
                text: `${state.myName} created the group`,
                from: state.myName,
                system: true
            });
            startPresence(groupId);
        }, 1000);
        
        notifyUpdate();
        
        return { groupId, shareUrl: getShareUrl() };
    }
    
    function joinGroup(secret, password = null) {
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) {
            throw new Error(`Maximum ${CONFIG.MAX_GROUPS} groups`);
        }
        
        const actualSecret = password ? Crypto.hash(password) : secret;
        const groupId = Crypto.deriveGroupId(actualSecret);
        
        if (state.groups[groupId]) {
            state.activeGroupId = groupId;
            saveState();
            notifyUpdate();
            return { groupId, alreadyJoined: true };
        }
        
        state.groups[groupId] = {
            id: groupId,
            name: 'Skating Group',
            secret: actualSecret,
            hasPassword: !!password,
            members: [state.myName],
            memberPubkeys: { [state.myName]: state.myPublicKey },
            messages: [],
            votes: {},
            connected: false,
            createdAt: Date.now()
        };
        
        state.activeGroupId = groupId;
        saveState();
        
        connectToRelays(groupId);
        
        setTimeout(() => {
            publishEvent(groupId, CONFIG.EVENT_KINDS.GROUP_MSG, {
                text: `${state.myName} joined the group`,
                from: state.myName,
                system: true
            });
            startPresence(groupId);
        }, 1000);
        
        notifyUpdate();
        
        return { groupId };
    }
    
    function leaveGroup(groupId) {
        const group = state.groups[groupId];
        if (!group) return;
        
        publishEvent(groupId, CONFIG.EVENT_KINDS.GROUP_MSG, {
            text: `${state.myName} left the group`,
            from: state.myName,
            system: true
        });
        
        disconnectFromRelays(groupId);
        delete state.groups[groupId];
        
        if (state.activeGroupId === groupId) {
            state.activeGroupId = Object.keys(state.groups)[0] || null;
        }
        
        saveState();
        notifyUpdate();
    }
    
    function switchGroup(groupId) {
        if (state.groups[groupId]) {
            state.activeGroupId = groupId;
            state.activeDmRecipient = null; // Clear DM view
            saveState();
            notifyUpdate();
        }
    }
    
    function sendMessage(text) {
        if (!state.activeGroupId || !text.trim()) return false;
        
        const trimmed = text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);
        
        return publishEvent(state.activeGroupId, CONFIG.EVENT_KINDS.GROUP_MSG, {
            text: trimmed,
            from: state.myName
        });
    }
    
    function shareProgram(program) {
        if (!state.activeGroupId) return false;
        
        const activity = program.Activity || program['Activity Title'] || 'Unknown';
        const location = program.LocationName || program['Location Name'] || '';
        const date = program['Start Date Time'] || program['Start Date'] || '';
        const time = program['Start Time'] || '';
        
        return publishEvent(state.activeGroupId, CONFIG.EVENT_KINDS.SHARE, {
            text: `⛸️ ${activity}`,
            from: state.myName,
            data: { activity, location, date, time }
        });
    }
    
    function voteTime(programIndex) {
        const group = state.groups[state.activeGroupId];
        if (!group) return false;
        
        if (!group.votes) group.votes = {};
        if (!group.votes[programIndex]) group.votes[programIndex] = [];
        
        const idx = group.votes[programIndex].indexOf(state.myName);
        const voted = idx === -1;
        
        if (voted) {
            group.votes[programIndex].push(state.myName);
        } else {
            group.votes[programIndex].splice(idx, 1);
        }
        
        saveState();
        notifyUpdate();
        
        return publishEvent(state.activeGroupId, CONFIG.EVENT_KINDS.VOTE, {
            programIndex,
            from: state.myName,
            voted
        });
    }
    
    function startDm(memberName) {
        const group = state.groups[state.activeGroupId];
        if (!group || !group.memberPubkeys) return false;
        
        const recipientPubkey = group.memberPubkeys[memberName];
        if (!recipientPubkey || recipientPubkey === state.myPublicKey) return false;
        
        // Initialize thread if needed
        if (!state.dmThreads[recipientPubkey]) {
            state.dmThreads[recipientPubkey] = {
                groupId: state.activeGroupId,
                name: memberName,
                messages: []
            };
        }
        
        state.activeDmRecipient = recipientPubkey;
        saveState();
        notifyUpdate();
        
        return true;
    }
    
    function sendDm(text) {
        if (!state.activeDmRecipient || !state.activeGroupId || !text.trim()) return false;
        
        const group = state.groups[state.activeGroupId];
        if (!group) return false;
        
        const thread = state.dmThreads[state.activeDmRecipient];
        if (!thread) return false;
        
        const trimmed = text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);
        
        // Encrypt DM payload with derived key
        const dmKey = Crypto.deriveDmKey(group.secret, state.myPublicKey, state.activeDmRecipient);
        const dmPayload = Crypto.encrypt(JSON.stringify({ text: trimmed }), dmKey);
        
        return publishEvent(state.activeGroupId, CONFIG.EVENT_KINDS.DM, {
            from: state.myName,
            toName: thread.name,
            dmPayload
        }, [['p', state.activeDmRecipient]]);
    }
    
    function closeDm() {
        state.activeDmRecipient = null;
        notifyUpdate();
    }
    
    function onUpdate(callback) {
        state.callbacks.push(callback);
        callback(getState());
    }
    
    function getState() {
        const activeGroup = state.groups[state.activeGroupId] || null;
        const activeDmThread = state.activeDmRecipient ? state.dmThreads[state.activeDmRecipient] : null;
        
        return {
            myName: state.myName,
            myPublicKey: state.myPublicKey,
            groups: state.groups,
            activeGroupId: state.activeGroupId,
            activeGroup,
            dmThreads: state.dmThreads,
            activeDmRecipient: state.activeDmRecipient,
            activeDmThread,
            viewMode: state.activeDmRecipient ? 'dm' : 'group'
        };
    }
    
    function getShareUrl() {
        const group = state.groups[state.activeGroupId];
        if (!group) return null;
        return `${window.location.origin}${window.location.pathname}#${group.secret}`;
    }
    
    function getConnectionStatus(groupId = null) {
        const gid = groupId || state.activeGroupId;
        const group = state.groups[gid];
        return group?.connected ? 'connected' : 'disconnected';
    }
    
    return {
        init,
        createGroup,
        joinGroup,
        leaveGroup,
        switchGroup,
        sendMessage,
        shareProgram,
        voteTime,
        startDm,
        sendDm,
        closeDm,
        onUpdate,
        getState,
        getShareUrl,
        getConnectionStatus,
        // Expose crypto helpers for potential reuse
        Crypto
    };
})();
