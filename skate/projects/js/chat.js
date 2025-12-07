/**
 * SkateChat - Encrypted group chat using Nostr protocol
 * Uses NostrTools for NIP-44 encryption and relay connections
 */

const SkateChat = (() => {
    'use strict';
    
    // ========== CONSTANTS ==========
    const CONFIG = {
        RELAYS: [
            'wss://relay.damus.io',
            'wss://nos.lol',
            'wss://relay.nostr.band'
        ],
        EVENT_KIND: 20100, // Ephemeral group message
        MAX_GROUPS: 5,
        MAX_MESSAGES: 100,
        MAX_MESSAGE_LENGTH: 500,
        RECONNECT_DELAY: 3000,
        STORAGE_KEY: 'skate_chat_groups',
        SESSION_KEY: 'skate_chat_session'
    };
    
    const ADJECTIVES = ['Swift', 'Gliding', 'Frozen', 'Quick', 'Cool', 'Icy', 'Smooth', 'Fast', 'Chill', 'Frosty'];
    const NOUNS = ['Skater', 'Penguin', 'Blade', 'Tiger', 'Bear', 'Fox', 'Wolf', 'Hawk', 'Star', 'Flash'];
    
    // ========== STATE ==========
    let state = {
        myName: null,
        myKeys: null,
        groups: {},
        activeGroupId: null,
        connections: new Map(), // groupId -> { pool, subs }
        callbacks: []
    };
    
    // ========== HELPERS ==========
    function generateName() {
        const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
        const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
        const num = Math.floor(Math.random() * 100);
        return `${adj}${noun}${num}`;
    }
    
    function generateGroupSecret(password = null) {
        if (password) {
            // Simple hash for password-based secret
            let hash = 0;
            for (let i = 0; i < password.length; i++) {
                hash = ((hash << 5) - hash) + password.charCodeAt(i);
                hash = hash & hash;
            }
            const bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                bytes[i] = (hash ^ (i * 17) ^ (password.charCodeAt(i % password.length) || 0)) & 0xff;
            }
            return bytesToHex(bytes);
        }
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return bytesToHex(bytes);
    }
    
    function deriveGroupId(secret) {
        // Simple derivation - first 12 chars of hashed secret
        let hash = 0;
        for (let i = 0; i < secret.length; i++) {
            hash = ((hash << 5) - hash) + secret.charCodeAt(i);
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16).padStart(12, '0').slice(0, 12);
    }
    
    function bytesToHex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    
    function hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        return bytes;
    }
    
    // ========== ENCRYPTION ==========
    async function encrypt(message, groupSecret) {
        try {
            // Use group secret as conversation key for NIP-44
            const keyBytes = hexToBytes(groupSecret.padEnd(64, '0').slice(0, 64));
            return await NostrTools.nip44.encrypt(message, keyBytes);
        } catch (e) {
            console.warn('[SkateChat] NIP-44 encrypt failed, using fallback:', e.message);
            // Fallback: simple base64
            return 'b64:' + btoa(unescape(encodeURIComponent(message)));
        }
    }
    
    async function decrypt(ciphertext, groupSecret) {
        try {
            if (ciphertext.startsWith('b64:')) {
                return decodeURIComponent(escape(atob(ciphertext.slice(4))));
            }
            const keyBytes = hexToBytes(groupSecret.padEnd(64, '0').slice(0, 64));
            return await NostrTools.nip44.decrypt(ciphertext, keyBytes);
        } catch (e) {
            console.warn('[SkateChat] Decrypt failed:', e.message);
            return '[Message could not be decrypted]';
        }
    }
    
    // ========== STORAGE ==========
    function loadState() {
        try {
            // Load groups from localStorage
            const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                state.groups = parsed.groups || {};
                state.activeGroupId = parsed.activeGroupId || null;
            }
            
            // Load session data
            const session = sessionStorage.getItem(CONFIG.SESSION_KEY);
            if (session) {
                const parsed = JSON.parse(session);
                state.myName = parsed.myName;
                state.myKeys = parsed.myKeys ? {
                    secretKey: hexToBytes(parsed.myKeys.secretKey),
                    publicKey: parsed.myKeys.publicKey
                } : null;
            }
            
            // Generate if missing
            if (!state.myName) {
                state.myName = generateName();
            }
            if (!state.myKeys && typeof NostrTools !== 'undefined') {
                const secretKey = NostrTools.generateSecretKey();
                state.myKeys = {
                    secretKey,
                    publicKey: NostrTools.getPublicKey(secretKey)
                };
            }
            
            saveSession();
        } catch (e) {
            console.error('[SkateChat] Load state error:', e);
        }
    }
    
    function saveState() {
        try {
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
                groups: state.groups,
                activeGroupId: state.activeGroupId
            }));
        } catch (e) {
            console.error('[SkateChat] Save state error:', e);
        }
    }
    
    function saveSession() {
        try {
            sessionStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify({
                myName: state.myName,
                myKeys: state.myKeys ? {
                    secretKey: bytesToHex(state.myKeys.secretKey),
                    publicKey: state.myKeys.publicKey
                } : null
            }));
        } catch (e) {
            console.error('[SkateChat] Save session error:', e);
        }
    }
    
    // ========== NETWORK ==========
    async function connectGroup(groupId) {
        const group = state.groups[groupId];
        if (!group) return;
        
        // Disconnect existing
        disconnectGroup(groupId);
        
        try {
            const pool = new NostrTools.SimplePool();
            const filter = {
                kinds: [CONFIG.EVENT_KIND],
                '#g': [groupId],
                since: Math.floor(Date.now() / 1000) - 3600 // Last hour
            };
            
            const sub = pool.subscribeMany(CONFIG.RELAYS, [filter], {
                onevent: async (event) => {
                    await handleEvent(groupId, event);
                },
                oneose: () => {
                    console.log(`[SkateChat] Got all past events for ${groupId}`);
                }
            });
            
            state.connections.set(groupId, { pool, sub });
            group.connected = true;
            console.log(`[SkateChat] Connected to group ${groupId}`);
            notifyUpdate();
            
        } catch (e) {
            console.error(`[SkateChat] Connect error for ${groupId}:`, e);
            group.connected = false;
            notifyUpdate();
        }
    }
    
    function disconnectGroup(groupId) {
        const conn = state.connections.get(groupId);
        if (conn) {
            try {
                conn.sub?.close();
                conn.pool?.close(CONFIG.RELAYS);
            } catch (e) {
                console.warn('[SkateChat] Disconnect error:', e);
            }
            state.connections.delete(groupId);
        }
        
        const group = state.groups[groupId];
        if (group) {
            group.connected = false;
        }
    }
    
    async function handleEvent(groupId, event) {
        const group = state.groups[groupId];
        if (!group) return;
        
        try {
            // Verify event
            if (!NostrTools.verifyEvent(event)) {
                console.warn('[SkateChat] Invalid event signature');
                return;
            }
            
            // Decrypt content
            const content = await decrypt(event.content, group.secret);
            const msg = JSON.parse(content);
            
            // Check if from self
            const isMine = event.pubkey === state.myKeys?.publicKey;
            
            // Add to messages
            addMessage(groupId, {
                id: event.id,
                type: msg.type || 'chat',
                text: msg.text || '',
                from: msg.from || 'Anonymous',
                fromPubkey: event.pubkey,
                mine: isMine,
                system: msg.type === 'system',
                ts: event.created_at * 1000,
                data: msg.data
            });
            
            // Track member
            if (msg.from && !group.members.includes(msg.from)) {
                group.members.push(msg.from);
                saveState();
            }
            
        } catch (e) {
            console.warn('[SkateChat] Handle event error:', e);
        }
    }
    
    async function publish(groupId, messageObj) {
        const group = state.groups[groupId];
        if (!group || !state.myKeys) return false;
        
        try {
            // Encrypt message
            const content = await encrypt(JSON.stringify(messageObj), group.secret);
            
            // Create event
            const event = {
                kind: CONFIG.EVENT_KIND,
                content,
                tags: [['g', groupId]],
                created_at: Math.floor(Date.now() / 1000)
            };
            
            const signedEvent = NostrTools.finalizeEvent(event, state.myKeys.secretKey);
            
            // Publish to relays
            const conn = state.connections.get(groupId);
            if (conn?.pool) {
                await conn.pool.publish(CONFIG.RELAYS, signedEvent);
                console.log('[SkateChat] Published message');
                return true;
            }
            
            // Fallback: direct publish
            for (const url of CONFIG.RELAYS) {
                try {
                    const relay = await NostrTools.Relay.connect(url);
                    await relay.publish(signedEvent);
                    relay.close();
                    return true;
                } catch (e) {
                    continue;
                }
            }
            
        } catch (e) {
            console.error('[SkateChat] Publish error:', e);
        }
        
        return false;
    }
    
    // ========== MESSAGES ==========
    function addMessage(groupId, msg) {
        const group = state.groups[groupId];
        if (!group) return;
        
        // Dedupe
        if (msg.id && group.messages.some(m => m.id === msg.id)) {
            return;
        }
        
        group.messages.push(msg);
        
        // Limit size
        if (group.messages.length > CONFIG.MAX_MESSAGES) {
            group.messages = group.messages.slice(-CONFIG.MAX_MESSAGES);
        }
        
        // Sort by timestamp
        group.messages.sort((a, b) => a.ts - b.ts);
        
        notifyUpdate();
    }
    
    // ========== CALLBACKS ==========
    function notifyUpdate() {
        const currentState = getState();
        state.callbacks.forEach(cb => {
            try { cb(currentState); } catch (e) { console.error(e); }
        });
    }
    
    // ========== PUBLIC API ==========
    function init() {
        if (typeof NostrTools === 'undefined') {
            console.error('[SkateChat] NostrTools not loaded!');
            return;
        }
        
        loadState();
        
        // Check URL for group join
        checkUrlJoin();
        
        // Connect to existing groups
        for (const groupId of Object.keys(state.groups)) {
            connectGroup(groupId);
        }
        
        console.log('[SkateChat] Initialized');
    }
    
    function checkUrlJoin() {
        const hash = window.location.hash.slice(1);
        if (hash && hash.length >= 32) {
            const existing = Object.values(state.groups).find(g => g.secret === hash);
            if (!existing) {
                // Join this group
                joinGroup(hash);
            }
        }
    }
    
    function createGroup(options = {}) {
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) {
            throw new Error(`Maximum ${CONFIG.MAX_GROUPS} groups allowed`);
        }
        
        const secret = generateGroupSecret(options.password);
        const groupId = deriveGroupId(secret);
        
        // Check if already exists
        if (state.groups[groupId]) {
            state.activeGroupId = groupId;
            saveState();
            notifyUpdate();
            return { groupId, shareUrl: getShareUrl(), alreadyExists: true };
        }
        
        state.groups[groupId] = {
            id: groupId,
            name: options.name || 'Skating Group',
            secret,
            hasPassword: !!options.password,
            members: [state.myName],
            messages: [],
            votes: {},
            connected: false,
            createdAt: Date.now()
        };
        
        state.activeGroupId = groupId;
        saveState();
        
        // Connect
        connectGroup(groupId);
        
        // Send join message
        publish(groupId, {
            type: 'system',
            text: `${state.myName} created the group`,
            from: state.myName
        });
        
        notifyUpdate();
        
        return { groupId, shareUrl: getShareUrl() };
    }
    
    function joinGroup(secret, password = null) {
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) {
            throw new Error(`Maximum ${CONFIG.MAX_GROUPS} groups allowed`);
        }
        
        // If password provided, regenerate secret from it
        const actualSecret = password ? generateGroupSecret(password) : secret;
        const groupId = deriveGroupId(actualSecret);
        
        // Check if already joined
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
            messages: [],
            votes: {},
            connected: false,
            createdAt: Date.now()
        };
        
        state.activeGroupId = groupId;
        saveState();
        
        // Connect
        connectGroup(groupId);
        
        // Send join message
        publish(groupId, {
            type: 'system',
            text: `${state.myName} joined the group`,
            from: state.myName
        });
        
        notifyUpdate();
        
        return { groupId };
    }
    
    function leaveGroup(groupId) {
        const group = state.groups[groupId];
        if (!group) return;
        
        // Send leave message
        publish(groupId, {
            type: 'system',
            text: `${state.myName} left the group`,
            from: state.myName
        });
        
        disconnectGroup(groupId);
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
            saveState();
            notifyUpdate();
        }
    }
    
    function sendMessage(text) {
        if (!state.activeGroupId || !text.trim()) return false;
        
        const trimmed = text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);
        
        return publish(state.activeGroupId, {
            type: 'chat',
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
        
        return publish(state.activeGroupId, {
            type: 'share',
            text: `⛸️ ${activity}`,
            from: state.myName,
            data: { activity, location, date, time }
        });
    }
    
    function voteTime(programIndex) {
        const group = state.groups[state.activeGroupId];
        if (!group) return false;
        
        // Toggle vote locally
        if (!group.votes[programIndex]) {
            group.votes[programIndex] = [];
        }
        
        const idx = group.votes[programIndex].indexOf(state.myName);
        if (idx === -1) {
            group.votes[programIndex].push(state.myName);
        } else {
            group.votes[programIndex].splice(idx, 1);
        }
        
        saveState();
        notifyUpdate();
        
        // Broadcast vote
        return publish(state.activeGroupId, {
            type: 'vote',
            from: state.myName,
            data: { program: programIndex, voted: idx === -1 }
        });
    }
    
    function onUpdate(callback) {
        state.callbacks.push(callback);
        callback(getState());
    }
    
    function getState() {
        const activeGroup = state.groups[state.activeGroupId] || null;
        return {
            myName: state.myName,
            myPublicKey: state.myKeys?.publicKey,
            groups: state.groups,
            activeGroupId: state.activeGroupId,
            activeGroup
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
    
    // Expose public API
    return {
        init,
        createGroup,
        joinGroup,
        leaveGroup,
        switchGroup,
        sendMessage,
        shareProgram,
        voteTime,
        onUpdate,
        getState,
        getShareUrl,
        getConnectionStatus
    };
})();
