/**
 * Storage Module - Smart localStorage management
 * Handles caching with expiration to avoid DDOS-ing City of Toronto API
 * City updates data daily at 8:00 AM EST
 */

const SkateStorage = {
    PREFIX: 'skate_',
    
    // Cache duration - 4 hours (data updates at 8 AM, so we refresh a few times daily)
    CACHE_DURATION_MS: 4 * 60 * 60 * 1000,
    
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
            const fullKey = this.PREFIX + key;
            const dataStr = JSON.stringify(data);
            
            // Check size before saving (localStorage limit ~5MB)
            const sizeKB = (dataStr.length * 2) / 1024; // UTF-16 = 2 bytes per char
            console.log(`[SkateStorage] Saving ${key}: ${sizeKB.toFixed(2)} KB`);
            
            if (sizeKB > 4000) {
                console.warn(`[SkateStorage] Data too large for ${key}, skipping cache`);
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

// Export for ES modules
if (typeof window !== 'undefined') {
    window.SkateStorage = SkateStorage;
}
