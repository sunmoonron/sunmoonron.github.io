/**
 * ChatState - Manages chat state and persistence
 * Handles multiple groups, messages, members, votes
 */

const ChatState = {
    // Current state
    _state: {
        groups: {},           // groupId -> { secret, name, password, createdAt, messages, members, votes }
        activeGroupId: null,
        myKeypair: null,
        myName: null,
        dmThreads: {}         // oderId -> { odername, messages }
    },
    
    // Change listeners
    _listeners: [],
    
    /**
     * Initialize state from storage
     */
    init() {
        this._loadFromStorage();
        this._ensureKeypair();
        this._ensureName();
        
        // Check URL for group join
        this._checkUrlForGroup();
    },
    
    /**
     * Get current state (immutable copy)
     */
    getState() {
        return {
            groups: { ...this._state.groups },
            activeGroupId: this._state.activeGroupId,
            activeGroup: this._state.activeGroupId ? this._state.groups[this._state.activeGroupId] : null,
            myName: this._state.myName,
            myPublicKey: this._state.myKeypair?.public,
            dmThreads: { ...this._state.dmThreads }
        };
    },
    
    /**
     * Get my keypair
     */
    getKeypair() {
        return this._state.myKeypair;
    },
    
    /**
     * Create a new group
     */
    createGroup(options = {}) {
        const { name = 'Skating Group', password = null } = options;
        
        if (Object.keys(this._state.groups).length >= ChatConfig.MAX_GROUPS) {
            throw new Error(`Maximum ${ChatConfig.MAX_GROUPS} groups allowed`);
        }
        
        const secret = ChatCrypto.generateGroupSecret(password);
        const groupId = ChatCrypto.deriveGroupId(secret);
        
        const group = {
            id: groupId,
            secret: secret,
            name: name,
            hasPassword: !!password,
            password: password,  // Store locally to reshare
            createdAt: Date.now(),
            messages: [],
            members: [this._state.myName],
            votes: {},
            isCreator: true
        };
        
        this._state.groups[groupId] = group;
        this._state.activeGroupId = groupId;
        
        this._updateUrl(secret);
        this._saveToStorage();
        this._notify();
        
        return {
            groupId,
            shareUrl: this._buildShareUrl(secret, password),
            shortCode: groupId.slice(0, 6).toUpperCase()
        };
    },
    
    /**
     * Join an existing group
     */
    joinGroup(secret, password = null) {
        // Apply password if provided
        const finalSecret = password ? ChatCrypto.applyPassword(secret, password) : secret;
        const groupId = ChatCrypto.deriveGroupId(finalSecret);
        
        // Check if already in this group
        if (this._state.groups[groupId]) {
            this._state.activeGroupId = groupId;
            this._notify();
            return { groupId, alreadyJoined: true };
        }
        
        if (Object.keys(this._state.groups).length >= ChatConfig.MAX_GROUPS) {
            throw new Error(`Maximum ${ChatConfig.MAX_GROUPS} groups allowed`);
        }
        
        const group = {
            id: groupId,
            secret: finalSecret,
            name: 'Skating Group',
            hasPassword: !!password,
            password: password,
            createdAt: Date.now(),
            messages: [],
            members: [],
            votes: {},
            isCreator: false
        };
        
        this._state.groups[groupId] = group;
        this._state.activeGroupId = groupId;
        
        this._updateUrl(finalSecret);
        this._saveToStorage();
        this._notify();
        
        return {
            groupId,
            shareUrl: this._buildShareUrl(secret, password),
            shortCode: groupId.slice(0, 6).toUpperCase()
        };
    },
    
    /**
     * Leave a group
     */
    leaveGroup(groupId) {
        delete this._state.groups[groupId];
        
        if (this._state.activeGroupId === groupId) {
            // Switch to another group or null
            const remaining = Object.keys(this._state.groups);
            this._state.activeGroupId = remaining.length > 0 ? remaining[0] : null;
        }
        
        this._updateUrl(this._state.activeGroupId ? 
            this._state.groups[this._state.activeGroupId].secret : null);
        this._saveToStorage();
        this._notify();
    },
    
    /**
     * Switch active group
     */
    setActiveGroup(groupId) {
        if (this._state.groups[groupId]) {
            this._state.activeGroupId = groupId;
            this._updateUrl(this._state.groups[groupId].secret);
            this._saveToStorage();
            this._notify();
        }
    },
    
    /**
     * Add a message to a group
     */
    addMessage(groupId, message) {
        const group = this._state.groups[groupId];
        if (!group) return;
        
        // Avoid duplicates
        if (group.messages.some(m => m.id === message.id)) return;
        
        group.messages.push(message);
        group.messages.sort((a, b) => a.ts - b.ts);
        
        // Trim to max
        if (group.messages.length > ChatConfig.MAX_MESSAGES_STORED) {
            group.messages = group.messages.slice(-ChatConfig.MAX_MESSAGES_STORED);
        }
        
        this._saveToStorage();
        this._notify();
    },
    
    /**
     * Add/update member
     */
    addMember(groupId, memberName) {
        const group = this._state.groups[groupId];
        if (!group) return;
        
        if (!group.members.includes(memberName)) {
            group.members.push(memberName);
            this._saveToStorage();
            this._notify();
        }
    },
    
    /**
     * Add vote
     */
    addVote(groupId, programIndex, voterName) {
        const group = this._state.groups[groupId];
        if (!group) return;
        
        if (!group.votes[programIndex]) {
            group.votes[programIndex] = [];
        }
        
        if (!group.votes[programIndex].includes(voterName)) {
            group.votes[programIndex].push(voterName);
            this._saveToStorage();
            this._notify();
        }
    },
    
    /**
     * Get share URL for active group
     */
    getShareUrl(groupId = null) {
        const gid = groupId || this._state.activeGroupId;
        const group = this._state.groups[gid];
        if (!group) return null;
        
        return this._buildShareUrl(group.secret, group.password);
    },
    
    /**
     * Start DM thread
     */
    startDM(userId, userName) {
        if (!this._state.dmThreads[oderId]) {
            this._state.dmThreads[oderId] = {
                userName,
                oderId,
                messages: []
            };
            this._saveToStorage();
            this._notify();
        }
        return this._state.dmThreads[oderId];
    },
    
    /**
     * Add DM message
     */
    addDMMessage(oderId, message) {
        if (!this._state.dmThreads[oderId]) {
            this._state.dmThreads[oderId] = { oderId, messages: [] };
        }
        this._state.dmThreads[oderId].messages.push(message);
        this._saveToStorage();
        this._notify();
    },
    
    /**
     * Subscribe to state changes
     */
    subscribe(callback) {
        this._listeners.push(callback);
        return () => {
            this._listeners = this._listeners.filter(l => l !== callback);
        };
    },
    
    // ========== PRIVATE METHODS ==========
    
    _loadFromStorage() {
        try {
            const groupsJson = localStorage.getItem(ChatConfig.STORAGE.GROUPS);
            if (groupsJson) {
                this._state.groups = JSON.parse(groupsJson);
            }
            
            const activeId = localStorage.getItem(ChatConfig.STORAGE.ACTIVE_GROUP);
            if (activeId && this._state.groups[activeId]) {
                this._state.activeGroupId = activeId;
            }
            
            const keysJson = sessionStorage.getItem(ChatConfig.STORAGE.MY_KEYS);
            if (keysJson) {
                const keys = JSON.parse(keysJson);
                // Reconstruct Uint8Array
                keys.private = new Uint8Array(Object.values(keys.private));
                this._state.myKeypair = keys;
            }
            
            this._state.myName = sessionStorage.getItem(ChatConfig.STORAGE.MY_NAME);
        } catch (e) {
            console.warn('[ChatState] Failed to load from storage:', e);
        }
    },
    
    _saveToStorage() {
        try {
            localStorage.setItem(ChatConfig.STORAGE.GROUPS, JSON.stringify(this._state.groups));
            
            if (this._state.activeGroupId) {
                localStorage.setItem(ChatConfig.STORAGE.ACTIVE_GROUP, this._state.activeGroupId);
            } else {
                localStorage.removeItem(ChatConfig.STORAGE.ACTIVE_GROUP);
            }
            
            if (this._state.myKeypair) {
                sessionStorage.setItem(ChatConfig.STORAGE.MY_KEYS, JSON.stringify(this._state.myKeypair));
            }
            
            if (this._state.myName) {
                sessionStorage.setItem(ChatConfig.STORAGE.MY_NAME, this._state.myName);
            }
        } catch (e) {
            console.warn('[ChatState] Failed to save to storage:', e);
        }
    },
    
    _ensureKeypair() {
        if (!this._state.myKeypair) {
            this._state.myKeypair = ChatCrypto.generateKeypair();
            this._saveToStorage();
        }
    },
    
    _ensureName() {
        if (!this._state.myName) {
            const adj = ChatConfig.ADJECTIVES[Math.floor(Math.random() * ChatConfig.ADJECTIVES.length)];
            const noun = ChatConfig.NOUNS[Math.floor(Math.random() * ChatConfig.NOUNS.length)];
            const num = Math.floor(Math.random() * 100);
            this._state.myName = adj + noun + num;
            this._saveToStorage();
        }
    },
    
    _checkUrlForGroup() {
        const hash = window.location.hash.slice(1);
        if (!hash) return;
        
        const params = new URLSearchParams(hash);
        const secret = params.get('g');
        const needsPassword = params.get('p') === '1';
        
        if (secret) {
            if (needsPassword) {
                // Will need to prompt for password - store pending join
                this._state.pendingJoin = { secret, needsPassword: true };
                this._notify();
            } else {
                try {
                    this.joinGroup(secret);
                } catch (e) {
                    console.error('[ChatState] Failed to auto-join:', e);
                }
            }
        }
    },
    
    _buildShareUrl(secret, password = null) {
        const base = `${window.location.origin}${window.location.pathname}`;
        const params = new URLSearchParams();
        params.set('g', secret);
        if (password) {
            params.set('p', '1');  // Indicate password required
        }
        return `${base}#${params.toString()}`;
    },
    
    _updateUrl(secret) {
        if (secret) {
            const group = Object.values(this._state.groups).find(g => g.secret === secret);
            const params = new URLSearchParams();
            params.set('g', secret);
            if (group?.hasPassword) {
                params.set('p', '1');
            }
            history.replaceState(null, '', `#${params.toString()}`);
        } else {
            history.replaceState(null, '', window.location.pathname);
        }
    },
    
    _notify() {
        const state = this.getState();
        this._listeners.forEach(l => l(state));
    }
};

if (typeof window !== 'undefined') {
    window.ChatState = ChatState;
}
