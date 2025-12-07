/**
 * SkateChat Configuration
 * All magic numbers and constants in one place
 */

const ChatConfig = {
    // Version for cache busting
    VERSION: '4',
    
    // Timing
    MESSAGE_RETENTION_MS: 2 * 60 * 60 * 1000,  // 2 hours
    RECONNECT_DELAY_MS: 3000,
    CONNECTION_TIMEOUT_MS: 5000,
    TYPING_DEBOUNCE_MS: 500,
    
    // Limits
    MAX_MESSAGE_LENGTH: 500,
    MAX_MESSAGES_STORED: 100,
    MAX_GROUPS: 5,
    MAX_MEMBERS_DISPLAY: 20,
    
    // Nostr relays (prioritized)
    RELAYS: [
        'wss://relay.damus.io',
        'wss://nos.lol', 
        'wss://relay.nostr.band',
        'wss://nostr.wine'
    ],
    
    // Event kinds (ephemeral range 20000-29999)
    KINDS: {
        CHAT: 20100,
        VOTE: 20101,
        JOIN: 20102,
        LEAVE: 20103,
        SHARE: 20104,
        DM: 20105,
        TYPING: 20106
    },
    
    // UI
    COLORS: {
        primary: '#4a9',
        primaryHover: '#3a8',
        danger: '#c55',
        dangerHover: '#b44',
        muted: '#888',
        border: '#ccc',
        bgLight: '#f5f5f5',
        bgWhite: '#fff',
        bubbleMine: '#dcf8c6',
        bubbleOther: '#fff',
        bubbleSystem: '#f0f0f0',
        bubbleShared: '#e3f2fd'
    },
    
    // Anonymous name generator
    ADJECTIVES: ['Swift', 'Cool', 'Ice', 'Gliding', 'Fast', 'Chill', 'Frost', 'Blade', 'Snow', 'Quick'],
    NOUNS: ['Skater', 'Penguin', 'Bear', 'Fox', 'Wolf', 'Owl', 'Hawk', 'Tiger', 'Puck', 'Blade'],
    
    // Storage keys
    STORAGE: {
        GROUPS: 'skate_chat_groups',
        ACTIVE_GROUP: 'skate_chat_active',
        MY_NAME: 'skate_chat_name',
        MY_KEYS: 'skate_chat_keys'
    }
};

// Freeze to prevent accidental mutation
Object.freeze(ChatConfig);
Object.freeze(ChatConfig.KINDS);
Object.freeze(ChatConfig.COLORS);
Object.freeze(ChatConfig.STORAGE);

if (typeof window !== 'undefined') {
    window.ChatConfig = ChatConfig;
}
