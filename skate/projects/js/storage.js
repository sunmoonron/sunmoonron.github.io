/**
 * Storage Module - Lean localStorage management
 * Minimal caching to keep memory low
 * Auto-expires after 1 hour to ensure fresh data
 */

const SkateStorage = {
    PREFIX: 'skate_',
    
    // Cache duration - 1 hour (short to ensure fresh data, reduces memory bloat)
    CACHE_DURATION_MS: 1 * 60 * 60 * 1000,
    
    // Max storage size in KB (keep it lean)
    MAX_SIZE_KB: 2000,
    
    /**
     * Get next 8 AM EST timestamp
     */
    getNext8AM() {
        const now = new Date();
        const next8AM = new Date(now);
        next8AM.setHours(8, 0, 0, 0);
        
        // If it's past 8 AM, set to tomorrow
        if (now.getHours() >= 8) {
            next8AM.setDate(next8AM.getDate() + 1);
        }
        return next8AM.getTime();
    },
    
    /**
     * Check if cached data is still valid
     */
    isCacheValid(key) {
        const meta = this.getMeta(key);
        if (!meta) return false;
        
        const now = Date.now();
        // Invalid if past expiration OR past 8 AM of the next day
        return now < meta.expires && now < this.getNext8AM();
    },
    
    /**
     * Get metadata for a cached item
     */
    getMeta(key) {
        try {
            const metaStr = localStorage.getItem(this.PREFIX + key + '_meta');
            return metaStr ? JSON.parse(metaStr) : null;
        } catch (e) {
            return null;
        }
    },
    
    /**
     * Save data to localStorage with metadata
     */
    set(key, data) {
        try {
            // First cleanup old data
            this.cleanup();
            
            const fullKey = this.PREFIX + key;
            const dataStr = JSON.stringify(data);
            
            // Check size before saving
            const sizeKB = (dataStr.length * 2) / 1024;
            console.log(`[SkateStorage] Saving ${key}: ${sizeKB.toFixed(2)} KB`);
            
            // Reject if too large
            if (sizeKB > this.MAX_SIZE_KB) {
                console.warn(`[SkateStorage] Data too large (${sizeKB.toFixed(0)}KB > ${this.MAX_SIZE_KB}KB), skipping cache`);
                return false;
            }
            
            localStorage.setItem(fullKey, dataStr);
            localStorage.setItem(fullKey + '_meta', JSON.stringify({
                expires: Date.now() + this.CACHE_DURATION_MS,
                savedAt: Date.now(),
                count: Array.isArray(data) ? data.length : 1
            }));
            
            return true;
        } catch (e) {
            console.error('[SkateStorage] Save failed:', e);
            // Try to clear old data if quota exceeded
            if (e.name === 'QuotaExceededError') {
                this.clearAll();
            }
            return false;
        }
    },
    
    /**
     * Get data from localStorage
     */
    get(key) {
        try {
            if (!this.isCacheValid(key)) {
                return null;
            }
            const dataStr = localStorage.getItem(this.PREFIX + key);
            return dataStr ? JSON.parse(dataStr) : null;
        } catch (e) {
            console.error('[SkateStorage] Get failed:', e);
            return null;
        }
    },
    
    /**
     * Clear a specific cached item
     */
    clear(key) {
        localStorage.removeItem(this.PREFIX + key);
        localStorage.removeItem(this.PREFIX + key + '_meta');
    },
    
    /**
     * Clear all skate-related cache
     */
    clearAll() {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(this.PREFIX)) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
        console.log(`[SkateStorage] Cleared ${keysToRemove.length} items`);
    },
    
    /**
     * Cleanup expired entries (garbage collection)
     */
    cleanup() {
        const now = Date.now();
        const keysToRemove = [];
        
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(this.PREFIX) && key.endsWith('_meta')) {
                try {
                    const meta = JSON.parse(localStorage.getItem(key));
                    // Remove if expired or older than 24 hours
                    if (meta?.expires < now || (meta?.savedAt && now - meta.savedAt > 24 * 60 * 60 * 1000)) {
                        keysToRemove.push(key);
                        keysToRemove.push(key.replace('_meta', ''));
                    }
                } catch (e) {
                    keysToRemove.push(key);
                }
            }
        }
        
        keysToRemove.forEach(key => localStorage.removeItem(key));
        if (keysToRemove.length > 0) {
            console.log(`[SkateStorage] Garbage collected ${keysToRemove.length} expired entries`);
        }
    },
    
    /**
     * Get storage stats
     */
    getStats() {
        let totalSize = 0;
        const items = {};
        
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(this.PREFIX)) {
                const size = (localStorage.getItem(key).length * 2) / 1024;
                totalSize += size;
                items[key.replace(this.PREFIX, '')] = size.toFixed(2) + ' KB';
            }
        }
        
        return {
            totalSizeKB: totalSize.toFixed(2),
            items
        };
    }
};

// Run cleanup on load
SkateStorage.cleanup();

// Export for ES modules
if (typeof window !== 'undefined') {
    window.SkateStorage = SkateStorage;
}
