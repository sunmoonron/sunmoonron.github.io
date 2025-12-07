/**
 * ChatNetwork - Handles Nostr relay connections
 * Manages WebSocket connections, subscriptions, and message routing
 */

const ChatNetwork = {
    // Active connections per group
    connections: new Map(),  // groupId -> { relay, subscriptionId, status }
    
    // Message handlers
    handlers: new Map(),     // groupId -> callback function
    
    /**
     * Connect to relays for a specific group
     */
    async connect(groupId, onMessage) {
        if (this.connections.has(groupId)) {
            return this.connections.get(groupId).status;
        }
        
        this.handlers.set(groupId, onMessage);
        
        // Try relays in order
        for (const url of ChatConfig.RELAYS) {
            try {
                const result = await this._connectToRelay(url, groupId);
                if (result) {
                    console.log(`[ChatNetwork] Connected to ${url} for group ${groupId}`);
                    return 'connected';
                }
            } catch (e) {
                console.warn(`[ChatNetwork] Failed to connect to ${url}:`, e.message);
            }
        }
        
        console.error('[ChatNetwork] All relays failed');
        return 'disconnected';
    },
    
    /**
     * Disconnect from a specific group
     */
    disconnect(groupId) {
        const conn = this.connections.get(groupId);
        if (conn) {
            try {
                // Send CLOSE message
                if (conn.relay.readyState === WebSocket.OPEN) {
                    conn.relay.send(JSON.stringify(['CLOSE', conn.subscriptionId]));
                }
                conn.relay.close();
            } catch (e) {
                // Ignore close errors
            }
            this.connections.delete(groupId);
            this.handlers.delete(groupId);
        }
    },
    
    /**
     * Disconnect all
     */
    disconnectAll() {
        for (const groupId of this.connections.keys()) {
            this.disconnect(groupId);
        }
    },
    
    /**
     * Publish an event to relays
     */
    async publish(groupId, event) {
        const conn = this.connections.get(groupId);
        if (!conn || conn.relay.readyState !== WebSocket.OPEN) {
            console.warn('[ChatNetwork] Not connected, cannot publish');
            return false;
        }
        
        try {
            conn.relay.send(JSON.stringify(['EVENT', event]));
            return true;
        } catch (e) {
            console.error('[ChatNetwork] Publish error:', e);
            return false;
        }
    },
    
    /**
     * Get connection status for a group
     */
    getStatus(groupId) {
        const conn = this.connections.get(groupId);
        if (!conn) return 'disconnected';
        if (conn.relay.readyState === WebSocket.OPEN) return 'connected';
        if (conn.relay.readyState === WebSocket.CONNECTING) return 'connecting';
        return 'disconnected';
    },
    
    // ========== PRIVATE METHODS ==========
    
    async _connectToRelay(url, groupId) {
        return new Promise((resolve, reject) => {
            const relay = new WebSocket(url);
            const subscriptionId = 'skate_' + groupId + '_' + Date.now();
            
            const timeout = setTimeout(() => {
                relay.close();
                reject(new Error('Connection timeout'));
            }, ChatConfig.CONNECTION_TIMEOUT_MS);
            
            relay.onopen = () => {
                clearTimeout(timeout);
                
                // Subscribe to group events
                const since = Math.floor((Date.now() - ChatConfig.MESSAGE_RETENTION_MS) / 1000);
                const sub = JSON.stringify([
                    'REQ',
                    subscriptionId,
                    {
                        kinds: Object.values(ChatConfig.KINDS),
                        '#g': [groupId],
                        since: since
                    }
                ]);
                
                relay.send(sub);
                
                this.connections.set(groupId, {
                    relay,
                    subscriptionId,
                    status: 'connected',
                    url
                });
                
                resolve(true);
            };
            
            relay.onmessage = (e) => {
                this._handleMessage(groupId, e.data);
            };
            
            relay.onclose = () => {
                clearTimeout(timeout);
                const conn = this.connections.get(groupId);
                if (conn) {
                    conn.status = 'disconnected';
                    // Attempt reconnect
                    setTimeout(() => this._reconnect(groupId), ChatConfig.RECONNECT_DELAY_MS);
                }
            };
            
            relay.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('Connection error'));
            };
        });
    },
    
    _handleMessage(groupId, data) {
        try {
            const parsed = JSON.parse(data);
            
            if (parsed[0] === 'EVENT' && parsed[2]) {
                const handler = this.handlers.get(groupId);
                if (handler) {
                    handler(parsed[2]);
                }
            }
        } catch (e) {
            // Ignore parse errors
        }
    },
    
    async _reconnect(groupId) {
        const handler = this.handlers.get(groupId);
        if (handler && !this.connections.has(groupId)) {
            console.log('[ChatNetwork] Attempting reconnect for', groupId);
            await this.connect(groupId, handler);
        }
    }
};

if (typeof window !== 'undefined') {
    window.ChatNetwork = ChatNetwork;
}
