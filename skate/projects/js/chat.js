/**
 * SkateChat - Encrypted group chat using Nostr protocol
 * 
 * Features:
 * - Nostr ephemeral events for messaging
 * - Group encryption with shared secret
 * - DM support with derived keys
 * - Profanity filtering
 * - Unread DM tracking
 */

const SkateChat = (() => {
    'use strict';
    
    // ========== CONFIG ==========
    const CONFIG = {
        RELAYS: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'],
        EVENT_KINDS: { GROUP_MSG: 20100, DM: 20101, VOTE: 20102, SHARE: 20103, PRESENCE: 20104 },
        MAX_GROUPS: 5,
        MAX_MESSAGES: 100,
        MAX_MESSAGE_LENGTH: 500,
        STORAGE_KEY: 'skate_groups_v3',
        SESSION_KEY: 'skate_session_v3',
        PRESENCE_INTERVAL: 30000
    };
    
    const ADJECTIVES = ['Swift', 'Gliding', 'Frozen', 'Quick', 'Cool', 'Icy', 'Smooth', 'Fast', 'Chill', 'Frosty'];
    const NOUNS = ['Skater', 'Penguin', 'Blade', 'Tiger', 'Bear', 'Fox', 'Wolf', 'Hawk', 'Star', 'Flash'];
    
    // ========== STATE ==========
    const state = {
        myName: null,
        mySecretKey: null,
        myPublicKey: null,
        groups: {},
        activeGroupId: null,
        dmThreads: {},        // pubkey -> { name, groupId, messages[], unread }
        activeDmRecipient: null,
        connections: new Map(),
        callbacks: [],
        presenceTimers: new Map()
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
    
    // ========== CRYPTO ==========
    const Crypto = {
        randomHex(bytes = 32) {
            const arr = new Uint8Array(bytes);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        },
        
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
            return ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).repeat(4);
        },
        
        deriveKey(secret, salt = '') { return this.hash(secret + salt); },
        deriveGroupId(secret) { return this.hash(secret).slice(0, 12); },
        deriveDmKey(groupSecret, pk1, pk2) { return this.hash(groupSecret + [pk1, pk2].sort().join('')); },
        
        encrypt(plaintext, keyHex) {
            const keyBytes = this.hexToBytes(keyHex);
            const textBytes = new TextEncoder().encode(plaintext);
            const encrypted = new Uint8Array(textBytes.length);
            for (let i = 0; i < textBytes.length; i++) {
                encrypted[i] = textBytes[i] ^ keyBytes[i % keyBytes.length];
            }
            return btoa(String.fromCharCode(...encrypted));
        },
        
        decrypt(ciphertext, keyHex) {
            try {
                const keyBytes = this.hexToBytes(keyHex);
                const encrypted = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
                const decrypted = new Uint8Array(encrypted.length);
                for (let i = 0; i < encrypted.length; i++) {
                    decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
                }
                return new TextDecoder().decode(decrypted);
            } catch { return null; }
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
                state.dmThreads = p.dmThreads || {};
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
                dmThreads: state.dmThreads
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
    function connectToRelays(groupId) {
        const group = state.groups[groupId];
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
                        if (data[0] === 'EVENT' && data[2]) handleEvent(groupId, data[2]);
                    } catch {}
                };
                ws.onclose = () => {
                    const idx = sockets.indexOf(ws);
                    if (idx > -1) sockets.splice(idx, 1);
                    if (sockets.length === 0 && state.groups[groupId]) {
                        state.groups[groupId].connected = false;
                        notifyUpdate();
                        setTimeout(() => state.groups[groupId] && connectToRelays(groupId), 5000);
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
        const group = state.groups[groupId];
        if (!group || !state.mySecretKey) return false;
        
        try {
            const key = Crypto.deriveKey(group.secret);
            const encrypted = Crypto.encrypt(JSON.stringify(content), key);
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
    
    function handleEvent(groupId, event) {
        const group = state.groups[groupId];
        if (!group) return;
        if (!group._processedIds) group._processedIds = new Set();
        if (group._processedIds.has(event.id)) return;
        group._processedIds.add(event.id);
        if (group._processedIds.size > 500) group._processedIds = new Set(Array.from(group._processedIds).slice(-250));
        
        try {
            if (!NostrTools.verifyEvent(event)) return;
            const key = Crypto.deriveKey(group.secret);
            const decrypted = Crypto.decrypt(event.content, key);
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
                    break;
                    
                case CONFIG.EVENT_KINDS.SHARE:
                    addMessage(groupId, {
                        id: event.id, type: 'share', text: content.text,
                        from: content.from, fromPubkey: event.pubkey, mine: isMine,
                        ts: event.created_at * 1000, data: content.data
                    });
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
        const group = state.groups[groupId];
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
        
        const group = state.groups[groupId];
        const dmKey = Crypto.deriveDmKey(group.secret, event.pubkey, recipientPubkey);
        const dmContent = Crypto.decrypt(content.dmPayload, dmKey);
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
            }
        }
    }
    
    function addMessage(groupId, msg) {
        const group = state.groups[groupId];
        if (!group || group.messages.some(m => m.id === msg.id)) return;
        group.messages.push(msg);
        if (group.messages.length > CONFIG.MAX_MESSAGES) group.messages = group.messages.slice(-CONFIG.MAX_MESSAGES);
        group.messages.sort((a, b) => a.ts - b.ts);
    }
    
    function startPresence(groupId) {
        publishEvent(groupId, CONFIG.EVENT_KINDS.PRESENCE, { from: state.myName, status: 'online' });
        const timer = setInterval(() => {
            if (state.groups[groupId]) publishEvent(groupId, CONFIG.EVENT_KINDS.PRESENCE, { from: state.myName, status: 'online' });
        }, CONFIG.PRESENCE_INTERVAL);
        state.presenceTimers.set(groupId, timer);
    }
    
    function notifyUpdate() {
        const s = getState();
        state.callbacks.forEach(cb => { try { cb(s); } catch {} });
    }
    
    // ========== PUBLIC API ==========
    function init() {
        if (typeof NostrTools === 'undefined') { console.error('[SkateChat] NostrTools not loaded!'); return; }
        loadState();
        initIdentity();
        
        const hash = window.location.hash.slice(1);
        if (hash && hash.length >= 32) {
            const groupId = Crypto.deriveGroupId(hash);
            if (!state.groups[groupId]) joinGroup(hash);
            else state.activeGroupId = groupId;
        }
        
        for (const gid of Object.keys(state.groups)) {
            connectToRelays(gid);
            startPresence(gid);
        }
        
        console.log('[SkateChat] Initialized');
        notifyUpdate();
    }
    
    function createGroup(options = {}) {
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) throw new Error(`Max ${CONFIG.MAX_GROUPS} groups`);
        
        const name = options.name || 'Skating Group';
        if (Filter.check(name)) throw new Error('Group name contains inappropriate content');
        
        const secret = options.password ? Crypto.hash(options.password) : Crypto.randomHex(32);
        const groupId = Crypto.deriveGroupId(secret);
        
        if (state.groups[groupId]) {
            state.activeGroupId = groupId;
            saveState(); notifyUpdate();
            return { groupId, shareUrl: getShareUrl(), exists: true };
        }
        
        state.groups[groupId] = {
            id: groupId, name, secret, hasPassword: !!options.password,
            members: [state.myName], memberPubkeys: { [state.myName]: state.myPublicKey },
            messages: [], votes: {}, connected: false, createdAt: Date.now()
        };
        
        state.activeGroupId = groupId;
        saveState();
        connectToRelays(groupId);
        
        setTimeout(() => {
            publishEvent(groupId, CONFIG.EVENT_KINDS.GROUP_MSG, { text: `${state.myName} created the group`, from: state.myName, system: true });
            startPresence(groupId);
        }, 1000);
        
        notifyUpdate();
        return { groupId, shareUrl: getShareUrl() };
    }
    
    function joinGroup(secret, password = null) {
        if (Object.keys(state.groups).length >= CONFIG.MAX_GROUPS) throw new Error(`Max ${CONFIG.MAX_GROUPS} groups`);
        
        const actualSecret = password ? Crypto.hash(password) : secret;
        const groupId = Crypto.deriveGroupId(actualSecret);
        
        if (state.groups[groupId]) {
            state.activeGroupId = groupId;
            saveState(); notifyUpdate();
            return { groupId, alreadyJoined: true };
        }
        
        state.groups[groupId] = {
            id: groupId, name: 'Skating Group', secret: actualSecret, hasPassword: !!password,
            members: [state.myName], memberPubkeys: { [state.myName]: state.myPublicKey },
            messages: [], votes: {}, connected: false, createdAt: Date.now()
        };
        
        state.activeGroupId = groupId;
        saveState();
        connectToRelays(groupId);
        
        setTimeout(() => {
            publishEvent(groupId, CONFIG.EVENT_KINDS.GROUP_MSG, { text: `${state.myName} joined the group`, from: state.myName, system: true });
            startPresence(groupId);
        }, 1000);
        
        notifyUpdate();
        return { groupId };
    }
    
    function leaveGroup(groupId) {
        const group = state.groups[groupId];
        if (!group) return;
        publishEvent(groupId, CONFIG.EVENT_KINDS.GROUP_MSG, { text: `${state.myName} left the group`, from: state.myName, system: true });
        disconnectFromRelays(groupId);
        delete state.groups[groupId];
        if (state.activeGroupId === groupId) state.activeGroupId = Object.keys(state.groups)[0] || null;
        saveState(); notifyUpdate();
    }
    
    function switchGroup(groupId) {
        if (state.groups[groupId]) {
            state.activeGroupId = groupId;
            state.activeDmRecipient = null;
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
        const group = state.groups[state.activeGroupId];
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
        const group = state.groups[state.activeGroupId];
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
        
        const group = state.groups[state.activeGroupId];
        const thread = state.dmThreads[state.activeDmRecipient];
        if (!group || !thread) return false;
        
        const trimmed = text.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);
        const dmKey = Crypto.deriveDmKey(group.secret, state.myPublicKey, state.activeDmRecipient);
        const dmPayload = Crypto.encrypt(JSON.stringify({ text: trimmed }), dmKey);
        
        return publishEvent(state.activeGroupId, CONFIG.EVENT_KINDS.DM, {
            from: state.myName, toName: thread.name, dmPayload
        }, [['p', state.activeDmRecipient]]);
    }
    
    function closeDm() { state.activeDmRecipient = null; notifyUpdate(); }
    
    function onUpdate(callback) { state.callbacks.push(callback); callback(getState()); }
    
    function getState() {
        const activeGroup = state.groups[state.activeGroupId] || null;
        const activeDmThread = state.activeDmRecipient ? state.dmThreads[state.activeDmRecipient] : null;
        
        // Count total unread DMs
        let totalUnread = 0;
        Object.values(state.dmThreads).forEach(t => { totalUnread += t.unread || 0; });
        
        return {
            myName: state.myName,
            myPublicKey: state.myPublicKey,
            groups: state.groups,
            activeGroupId: state.activeGroupId,
            activeGroup,
            dmThreads: state.dmThreads,
            activeDmRecipient: state.activeDmRecipient,
            activeDmThread,
            totalUnread,
            viewMode: state.activeDmRecipient ? 'dm' : 'group'
        };
    }
    
    function getShareUrl() {
        const group = state.groups[state.activeGroupId];
        return group ? `${window.location.origin}${window.location.pathname}#${group.secret}` : null;
    }
    
    function getConnectionStatus(groupId = null) {
        const group = state.groups[groupId || state.activeGroupId];
        return group?.connected ? 'connected' : 'disconnected';
    }
    
    function getDmThreadsList() {
        return Object.entries(state.dmThreads).map(([pubkey, thread]) => ({
            pubkey, name: thread.name, unread: thread.unread || 0,
            lastMessage: thread.messages[thread.messages.length - 1] || null
        })).sort((a, b) => (b.lastMessage?.ts || 0) - (a.lastMessage?.ts || 0));
    }
    
    return {
        init, createGroup, joinGroup, leaveGroup, switchGroup,
        sendMessage, shareProgram, voteTime,
        startDm, sendDm, closeDm, getDmThreadsList,
        onUpdate, getState, getShareUrl, getConnectionStatus,
        Crypto, Filter
    };
})();
