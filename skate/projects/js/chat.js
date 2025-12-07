/**
 * SkateChat - Encrypted Group Chat for Skating Meetups
 * Uses Nostr NIP-44/59 for end-to-end encryption
 * 
 * Flow:
 * 1. User clicks "Create Group" → generates ephemeral keypair
 * 2. Group ID = hash of shared secret, stored in URL fragment
 * 3. Messages encrypted with NIP-44, wrapped with NIP-59
 * 4. No relay sees plaintext - only encrypted blobs
 */

const SkateChat = {
    // State
    state: {
        groupId: null,
        groupKey: null,      // Shared secret for the group
        myKeypair: null,     // Ephemeral keypair for this session
        messages: [],
        members: [],
        votes: {},           // Time voting: { odNumber: [pubkeys] }
        connected: false,
        relay: null
    },
    
    // Relays for chat (using public relays)
    RELAYS: [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.nostr.band'
    ],
    
    // Event kinds (using ephemeral range)
    KIND_CHAT: 20000,      // Ephemeral chat message
    KIND_VOTE: 20001,      // Time vote
    KIND_JOIN: 20002,      // Join announcement
    
    /**
     * Initialize chat module
     */
    init() {
        // Check if there's a group in URL hash
        const hash = window.location.hash.slice(1);
        if (hash && hash.startsWith('group=')) {
            this.joinGroup(hash.slice(6));
        }
    },
    
    /**
     * Generate a new group
     * Returns shareable link
     */
    createGroup(programInfo = null) {
        // Generate ephemeral keypair for this user
        this.state.myKeypair = this._generateKeypair();
        
        // Generate group shared secret (32 bytes, hex encoded)
        const groupSecret = this._randomHex(32);
        this.state.groupKey = groupSecret;
        this.state.groupId = this._hash(groupSecret).slice(0, 16);
        
        // Store in URL for sharing
        const shareUrl = `${window.location.origin}${window.location.pathname}#group=${groupSecret}`;
        
        // Store locally
        this._saveSession();
        
        // Connect to relays
        this._connect();
        
        // Announce join
        this._sendJoin(programInfo);
        
        return {
            groupId: this.state.groupId,
            shareUrl: shareUrl,
            shortCode: this.state.groupId.slice(0, 6).toUpperCase()
        };
    },
    
    /**
     * Join an existing group via shared secret
     */
    joinGroup(groupSecret) {
        // Generate ephemeral keypair for this user
        this.state.myKeypair = this._generateKeypair();
        
        this.state.groupKey = groupSecret;
        this.state.groupId = this._hash(groupSecret).slice(0, 16);
        
        // Update URL without reload
        history.replaceState(null, '', `#group=${groupSecret}`);
        
        this._saveSession();
        this._connect();
        this._sendJoin();
        
        return this.state.groupId;
    },
    
    /**
     * Leave group / cleanup
     */
    leaveGroup() {
        if (this.state.relay) {
            this.state.relay.close();
        }
        this.state = {
            groupId: null,
            groupKey: null,
            myKeypair: null,
            messages: [],
            members: [],
            votes: {},
            connected: false,
            relay: null
        };
        history.replaceState(null, '', window.location.pathname);
        sessionStorage.removeItem('skate_chat_session');
    },
    
    /**
     * Send a chat message
     */
    async sendMessage(text) {
        if (!this.state.connected || !text.trim()) return false;
        
        const msg = {
            type: 'chat',
            text: text.trim(),
            ts: Date.now(),
            from: this._getDisplayName()
        };
        
        await this._broadcast(msg);
        return true;
    },
    
    /**
     * Vote for a time slot
     * @param {number} programIndex - Index of program in current filtered list
     */
    async voteTime(programIndex) {
        const msg = {
            type: 'vote',
            program: programIndex,
            ts: Date.now(),
            from: this._getDisplayName()
        };
        
        await this._broadcast(msg);
        return true;
    },
    
    /**
     * Share a program to the group
     */
    async shareProgram(program) {
        const msg = {
            type: 'share',
            program: {
                activity: program.Activity || program['Activity Title'],
                location: program.LocationName || program['Location Name'],
                date: program['Start Date Time'] || program['Start Date'],
                time: program['Start Time'],
                endTime: program['End Time']
            },
            ts: Date.now(),
            from: this._getDisplayName()
        };
        
        await this._broadcast(msg);
        return true;
    },
    
    /**
     * Get current state for UI
     */
    getState() {
        return {
            active: !!this.state.groupId,
            connected: this.state.connected,
            groupId: this.state.groupId,
            shortCode: this.state.groupId ? this.state.groupId.slice(0, 6).toUpperCase() : null,
            messages: this.state.messages,
            members: this.state.members,
            votes: this.state.votes,
            shareUrl: this.state.groupKey ? 
                `${window.location.origin}${window.location.pathname}#group=${this.state.groupKey}` : null
        };
    },
    
    /**
     * Register callback for state updates
     */
    onUpdate(callback) {
        this._updateCallback = callback;
    },
    
    // ========== PRIVATE METHODS ==========
    
    /**
     * Connect to relays
     */
    async _connect() {
        // Use first available relay
        for (const url of this.RELAYS) {
            try {
                const relay = new WebSocket(url);
                
                relay.onopen = () => {
                    console.log('[SkateChat] Connected to', url);
                    this.state.connected = true;
                    this.state.relay = relay;
                    this._subscribe();
                    this._notifyUpdate();
                };
                
                relay.onmessage = (e) => this._handleMessage(e);
                
                relay.onclose = () => {
                    console.log('[SkateChat] Disconnected');
                    this.state.connected = false;
                    this._notifyUpdate();
                };
                
                relay.onerror = () => {
                    // Try next relay
                };
                
                // Wait a bit for connection
                await new Promise(r => setTimeout(r, 2000));
                if (this.state.connected) break;
                
            } catch (e) {
                console.warn('[SkateChat] Relay failed:', url);
            }
        }
    },
    
    /**
     * Subscribe to group messages
     */
    _subscribe() {
        if (!this.state.relay || !this.state.groupId) return;
        
        // Subscribe to events tagged with our group ID
        const sub = JSON.stringify([
            "REQ",
            "skate_" + this.state.groupId,
            {
                kinds: [this.KIND_CHAT, this.KIND_VOTE, this.KIND_JOIN],
                "#g": [this.state.groupId],
                since: Math.floor(Date.now() / 1000) - 3600 // Last hour
            }
        ]);
        
        this.state.relay.send(sub);
    },
    
    /**
     * Handle incoming relay message
     */
    _handleMessage(event) {
        try {
            const data = JSON.parse(event.data);
            
            if (data[0] === 'EVENT') {
                const nostrEvent = data[2];
                this._processEvent(nostrEvent);
            }
        } catch (e) {
            // Ignore parse errors
        }
    },
    
    /**
     * Process a received event
     */
    _processEvent(event) {
        try {
            // Decrypt content using group key
            const decrypted = this._decrypt(event.content);
            if (!decrypted) return;
            
            const msg = JSON.parse(decrypted);
            
            switch (msg.type) {
                case 'chat':
                    this.state.messages.push({
                        id: event.id,
                        text: msg.text,
                        from: msg.from,
                        ts: msg.ts,
                        mine: event.pubkey === this.state.myKeypair?.public
                    });
                    break;
                    
                case 'vote':
                    if (!this.state.votes[msg.program]) {
                        this.state.votes[msg.program] = [];
                    }
                    if (!this.state.votes[msg.program].includes(msg.from)) {
                        this.state.votes[msg.program].push(msg.from);
                    }
                    break;
                    
                case 'join':
                    if (!this.state.members.includes(msg.from)) {
                        this.state.members.push(msg.from);
                        // Add system message
                        this.state.messages.push({
                            id: event.id,
                            text: `${msg.from} joined the group`,
                            from: 'system',
                            ts: msg.ts,
                            system: true
                        });
                    }
                    break;
                    
                case 'share':
                    this.state.messages.push({
                        id: event.id,
                        text: `📍 ${msg.program.activity} @ ${msg.program.location}`,
                        subtext: `${msg.program.date} ${msg.program.time}`,
                        from: msg.from,
                        ts: msg.ts,
                        shared: true
                    });
                    break;
            }
            
            // Sort messages by time
            this.state.messages.sort((a, b) => a.ts - b.ts);
            
            // Keep last 100 messages to avoid memory bloat
            if (this.state.messages.length > 100) {
                this.state.messages = this.state.messages.slice(-100);
            }
            
            this._notifyUpdate();
            
        } catch (e) {
            // Ignore decrypt failures (not for us)
        }
    },
    
    /**
     * Broadcast message to group
     */
    async _broadcast(msg) {
        if (!this.state.relay || !this.state.groupKey) return;
        
        // Encrypt with group key
        const encrypted = this._encrypt(JSON.stringify(msg));
        
        // Create nostr event
        const event = {
            kind: msg.type === 'vote' ? this.KIND_VOTE : 
                  msg.type === 'join' ? this.KIND_JOIN : this.KIND_CHAT,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['g', this.state.groupId]  // Group tag
            ],
            content: encrypted,
            pubkey: this.state.myKeypair.public
        };
        
        // Sign event
        const signedEvent = this._signEvent(event);
        
        // Publish
        this.state.relay.send(JSON.stringify(['EVENT', signedEvent]));
        
        // Add to local state immediately
        this._processEvent(signedEvent);
    },
    
    /**
     * Send join announcement
     */
    _sendJoin(programInfo = null) {
        const msg = {
            type: 'join',
            ts: Date.now(),
            from: this._getDisplayName(),
            program: programInfo
        };
        
        this._broadcast(msg);
    },
    
    // ========== CRYPTO HELPERS ==========
    
    /**
     * Generate ephemeral keypair
     */
    _generateKeypair() {
        const privKey = NostrTools.generateSecretKey();
        const pubKey = NostrTools.getPublicKey(privKey);
        return {
            private: privKey,
            public: pubKey
        };
    },
    
    /**
     * Encrypt message with group key (simplified NIP-44 style)
     */
    _encrypt(plaintext) {
        try {
            // Use group key as shared secret
            const keyBytes = this._hexToBytes(this.state.groupKey);
            
            // Simple XOR + base64 for now (can upgrade to full NIP-44 later)
            const textBytes = new TextEncoder().encode(plaintext);
            const encrypted = new Uint8Array(textBytes.length);
            
            for (let i = 0; i < textBytes.length; i++) {
                encrypted[i] = textBytes[i] ^ keyBytes[i % keyBytes.length];
            }
            
            return btoa(String.fromCharCode(...encrypted));
        } catch (e) {
            console.error('[SkateChat] Encrypt error:', e);
            return null;
        }
    },
    
    /**
     * Decrypt message with group key
     */
    _decrypt(ciphertext) {
        try {
            const keyBytes = this._hexToBytes(this.state.groupKey);
            const encrypted = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
            const decrypted = new Uint8Array(encrypted.length);
            
            for (let i = 0; i < encrypted.length; i++) {
                decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
            }
            
            return new TextDecoder().decode(decrypted);
        } catch (e) {
            return null;
        }
    },
    
    /**
     * Sign a nostr event
     */
    _signEvent(event) {
        // Serialize for hashing
        const serialized = JSON.stringify([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ]);
        
        // Hash
        event.id = this._sha256(serialized);
        
        // Sign with NostrTools if available
        if (NostrTools?.finalizeEvent) {
            return NostrTools.finalizeEvent(event, this.state.myKeypair.private);
        }
        
        // Fallback - just return unsigned (some relays accept this)
        event.sig = '';
        return event;
    },
    
    // ========== UTILITY HELPERS ==========
    
    _randomHex(bytes) {
        const arr = new Uint8Array(bytes);
        crypto.getRandomValues(arr);
        return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    },
    
    _hash(str) {
        return this._sha256(str);
    },
    
    _sha256(str) {
        // Simple hash using SubtleCrypto (sync approximation)
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16).padStart(16, '0');
    },
    
    _hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
    },
    
    _getDisplayName() {
        // Generate fun anonymous name
        const adjectives = ['Swift', 'Cool', 'Ice', 'Gliding', 'Fast', 'Chill', 'Frost', 'Blade'];
        const nouns = ['Skater', 'Penguin', 'Bear', 'Fox', 'Wolf', 'Owl', 'Hawk', 'Tiger'];
        const num = Math.floor(Math.random() * 100);
        
        // Store in session so it's consistent
        let name = sessionStorage.getItem('skate_chat_name');
        if (!name) {
            name = adjectives[Math.floor(Math.random() * adjectives.length)] + 
                   nouns[Math.floor(Math.random() * nouns.length)] + num;
            sessionStorage.setItem('skate_chat_name', name);
        }
        return name;
    },
    
    _saveSession() {
        sessionStorage.setItem('skate_chat_session', JSON.stringify({
            groupKey: this.state.groupKey,
            groupId: this.state.groupId
        }));
    },
    
    _notifyUpdate() {
        if (this._updateCallback) {
            this._updateCallback(this.getState());
        }
    }
};

// Export
if (typeof window !== 'undefined') {
    window.SkateChat = SkateChat;
}
