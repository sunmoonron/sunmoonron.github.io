/**
 * SkateChat - Main chat controller
 * Coordinates between state, network, crypto, and UI
 */

const SkateChat = {
    _initialized: false,
    
    /**
     * Initialize chat system
     */
    init() {
        if (this._initialized) return;
        this._initialized = true;
        
        // Initialize state
        ChatState.init();
        
        // Connect to active groups
        const state = ChatState.getState();
        for (const groupId of Object.keys(state.groups)) {
            this._connectGroup(groupId);
        }
        
        // Subscribe to state changes
        ChatState.subscribe((state) => {
            if (this._uiCallback) {
                this._uiCallback(state);
            }
        });
        
        console.log('[SkateChat] Initialized');
    },
    
    /**
     * Register UI callback
     */
    onUpdate(callback) {
        this._uiCallback = callback;
        // Immediately call with current state
        callback(ChatState.getState());
    },
    
    /**
     * Create a new group
     */
    createGroup(options = {}) {
        const result = ChatState.createGroup(options);
        this._connectGroup(result.groupId);
        this._sendSystemMessage(result.groupId, 'join');
        return result;
    },
    
    /**
     * Join a group
     */
    joinGroup(secret, password = null) {
        const result = ChatState.joinGroup(secret, password);
        if (!result.alreadyJoined) {
            this._connectGroup(result.groupId);
            this._sendSystemMessage(result.groupId, 'join');
        }
        return result;
    },
    
    /**
     * Leave a group
     */
    leaveGroup(groupId = null) {
        const gid = groupId || ChatState.getState().activeGroupId;
        if (!gid) return;
        
        this._sendSystemMessage(gid, 'leave');
        ChatNetwork.disconnect(gid);
        ChatState.leaveGroup(gid);
    },
    
    /**
     * Switch active group
     */
    switchGroup(groupId) {
        ChatState.setActiveGroup(groupId);
    },
    
    /**
     * Send a chat message
     */
    sendMessage(text) {
        const state = ChatState.getState();
        if (!state.activeGroup || !text.trim()) return false;
        
        const trimmed = text.trim().slice(0, ChatConfig.MAX_MESSAGE_LENGTH);
        
        const msg = {
            type: 'chat',
            text: trimmed,
            from: state.myName,
            ts: Date.now()
        };
        
        this._broadcast(state.activeGroupId, msg);
        return true;
    },
    
    /**
     * Vote for a time slot
     */
    voteTime(programIndex) {
        const state = ChatState.getState();
        if (!state.activeGroup) return false;
        
        const msg = {
            type: 'vote',
            program: programIndex,
            from: state.myName,
            ts: Date.now()
        };
        
        this._broadcast(state.activeGroupId, msg);
        return true;
    },
    
    /**
     * Share a program to the group
     */
    shareProgram(program) {
        const state = ChatState.getState();
        if (!state.activeGroup) return false;
        
        const msg = {
            type: 'share',
            program: {
                activity: program.Activity || program['Activity Title'],
                location: program.LocationName || program['Location Name'],
                date: program['Start Date Time'] || program['Start Date'],
                time: program['Start Time'],
                endTime: program['End Time']
            },
            from: state.myName,
            ts: Date.now()
        };
        
        this._broadcast(state.activeGroupId, msg);
        return true;
    },
    
    /**
     * Send a DM to a group member
     */
    sendDM(toUserId, toUserName, text) {
        const state = ChatState.getState();
        if (!state.activeGroup || !text.trim()) return false;
        
        // Create DM key and encrypt
        // For now, DMs go through the same channel but marked as DM
        const msg = {
            type: 'dm',
            to: toUserId,
            toName: toUserName,
            text: text.trim().slice(0, ChatConfig.MAX_MESSAGE_LENGTH),
            from: state.myName,
            fromId: state.myPublicKey,
            ts: Date.now()
        };
        
        this._broadcast(state.activeGroupId, msg);
        return true;
    },
    
    /**
     * Get share URL for current group
     */
    getShareUrl() {
        return ChatState.getShareUrl();
    },
    
    /**
     * Get current state
     */
    getState() {
        return ChatState.getState();
    },
    
    /**
     * Check if there's a pending join that needs password
     */
    getPendingJoin() {
        return ChatState.getState().pendingJoin || null;
    },
    
    /**
     * Complete pending join with password
     */
    completePendingJoin(password) {
        const pending = this.getPendingJoin();
        if (pending) {
            return this.joinGroup(pending.secret, password);
        }
        return null;
    },
    
    // ========== PRIVATE METHODS ==========
    
    async _connectGroup(groupId) {
        const state = ChatState.getState();
        const group = state.groups[groupId];
        if (!group) return;
        
        const status = await ChatNetwork.connect(groupId, (event) => {
            this._handleEvent(groupId, event);
        });
        
        console.log(`[SkateChat] Group ${groupId} connection: ${status}`);
    },
    
    _handleEvent(groupId, event) {
        const state = ChatState.getState();
        const group = state.groups[groupId];
        if (!group) return;
        
        try {
            // Decrypt content
            const decrypted = ChatCrypto.decrypt(event.content, group.secret);
            if (!decrypted) return;
            
            const msg = JSON.parse(decrypted);
            const myName = state.myName;
            const isMine = msg.from === myName;
            
            switch (msg.type) {
                case 'chat':
                    ChatState.addMessage(groupId, {
                        id: event.id,
                        type: 'chat',
                        text: msg.text,
                        from: msg.from,
                        ts: msg.ts,
                        mine: isMine
                    });
                    break;
                    
                case 'vote':
                    ChatState.addVote(groupId, msg.program, msg.from);
                    break;
                    
                case 'join':
                    ChatState.addMember(groupId, msg.from);
                    if (!isMine) {
                        ChatState.addMessage(groupId, {
                            id: event.id,
                            type: 'system',
                            text: `${msg.from} joined`,
                            ts: msg.ts,
                            system: true
                        });
                    }
                    break;
                    
                case 'leave':
                    if (!isMine) {
                        ChatState.addMessage(groupId, {
                            id: event.id,
                            type: 'system',
                            text: `${msg.from} left`,
                            ts: msg.ts,
                            system: true
                        });
                    }
                    break;
                    
                case 'share':
                    ChatState.addMessage(groupId, {
                        id: event.id,
                        type: 'share',
                        text: `📍 ${msg.program.activity}`,
                        subtext: `${msg.program.location} • ${msg.program.time || ''}`,
                        from: msg.from,
                        ts: msg.ts,
                        mine: isMine,
                        program: msg.program
                    });
                    break;
                    
                case 'dm':
                    // Only process if addressed to me
                    if (msg.to === state.myPublicKey) {
                        ChatState.addDMMessage(msg.fromId, {
                            id: event.id,
                            text: msg.text,
                            from: msg.from,
                            ts: msg.ts,
                            mine: false
                        });
                    } else if (isMine) {
                        // My outgoing DM
                        ChatState.addDMMessage(msg.to, {
                            id: event.id,
                            text: msg.text,
                            from: msg.from,
                            ts: msg.ts,
                            mine: true
                        });
                    }
                    break;
            }
        } catch (e) {
            // Ignore decrypt/parse failures
        }
    },
    
    async _broadcast(groupId, msg) {
        const state = ChatState.getState();
        const group = state.groups[groupId];
        if (!group) return;
        
        const encrypted = ChatCrypto.encrypt(JSON.stringify(msg), group.secret);
        if (!encrypted) return;
        
        const event = {
            kind: this._getKind(msg.type),
            created_at: Math.floor(Date.now() / 1000),
            tags: [['g', groupId]],
            content: encrypted,
            pubkey: state.myPublicKey
        };
        
        // Sign event
        event.id = ChatCrypto.randomHex(32);
        event.sig = '';  // Simplified - real impl would sign properly
        
        const success = await ChatNetwork.publish(groupId, event);
        
        // Optimistically add to local state
        if (success) {
            this._handleEvent(groupId, event);
        }
    },
    
    _sendSystemMessage(groupId, type) {
        const state = ChatState.getState();
        
        const msg = {
            type: type,
            from: state.myName,
            ts: Date.now()
        };
        
        this._broadcast(groupId, msg);
    },
    
    _getKind(msgType) {
        switch (msgType) {
            case 'vote': return ChatConfig.KINDS.VOTE;
            case 'join': return ChatConfig.KINDS.JOIN;
            case 'leave': return ChatConfig.KINDS.LEAVE;
            case 'share': return ChatConfig.KINDS.SHARE;
            case 'dm': return ChatConfig.KINDS.DM;
            default: return ChatConfig.KINDS.CHAT;
        }
    }
};

if (typeof window !== 'undefined') {
    window.SkateChat = SkateChat;
}
