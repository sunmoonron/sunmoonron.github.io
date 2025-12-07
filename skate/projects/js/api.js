/**
 * API Module - Loads skating data from Firebase Storage or local fallback
 * 
 * Data is automatically updated weekly via Firebase Cloud Functions
 * Falls back to local static files if Firebase is unavailable
 * 
 * No CORS issues since Firebase Storage allows cross-origin reads!
 */

const SkateAPI = {
    // Firebase Storage URL - UPDATE THIS after deploying functions!
    // Format: https://storage.googleapis.com/YOUR-PROJECT-ID.appspot.com/skating-data/skating-programs.json
    FIREBASE_STORAGE_URL: null, // Set this after deployment, or leave null to use local files
    
    // Fallback: Local static data files (relative to skate.html)
    LOCAL_DATA_PATH: 'projects/data',
    
    // Cached data
    _skatingPrograms: null,
    _locations: null,
    _facilities: null,
    _metadata: null,
    
    /**
     * Configure the API with your Firebase Storage URL
     * Call this before loading data if using Firebase
     */
    configure(options = {}) {
        if (options.storageUrl) {
            this.FIREBASE_STORAGE_URL = options.storageUrl;
        }
    },
    
    /**
     * Fetch JSON from URL (Firebase Storage or local)
     */
    async fetchData(filename) {
        // Try Firebase Storage first if configured
        if (this.FIREBASE_STORAGE_URL) {
            try {
                const url = this.FIREBASE_STORAGE_URL;
                console.log(`[SkateAPI] Loading from Firebase: ${url}`);
                
                const response = await fetch(url);
                if (response.ok) {
                    return response.json();
                }
                console.warn(`[SkateAPI] Firebase fetch failed, falling back to local`);
            } catch (e) {
                console.warn(`[SkateAPI] Firebase error: ${e.message}, falling back to local`);
            }
        }
        
        // Fallback to local file
        const localUrl = `${this.LOCAL_DATA_PATH}/${filename}`;
        console.log(`[SkateAPI] Loading from local: ${localUrl}`);
        
        const response = await fetch(localUrl);
        if (!response.ok) {
            throw new Error(`Failed to load ${filename}: ${response.status}`);
        }
        
        return response.json();
    },
    
    /**
     * Get skating programs from Firebase Storage or local JSON
     * Main method - this is what the UI calls
     */
    async getSkatingPrograms() {
        // Data is ~9MB, too large for localStorage (5MB limit)
        // Just load each time - it's cached by browser HTTP cache
        
        if (this._skatingPrograms) {
            console.log(`[SkateAPI] Using memory cache: ${this._skatingPrograms.length} programs`);
            return this._skatingPrograms;
        }
        
        // Load from Firebase Storage or local file
        try {
            const data = await this.fetchData('skating-programs.json');
            
            this._metadata = data.metadata;
            this._skatingPrograms = data.programs || [];
            
            console.log(`[SkateAPI] Loaded ${this._skatingPrograms.length} skating programs`);
            console.log(`[SkateAPI] Data last updated: ${this._metadata?.lastUpdated}`);
            
            // Store just metadata in localStorage (small)
            SkateStorage.set('skating_metadata', this._metadata);
            
            return this._skatingPrograms;
            
        } catch (error) {
            console.error('[SkateAPI] Failed to load skating programs:', error);
            
            // Show helpful error
            throw new Error(
                'Skating data not found. Check Firebase Storage or run "node fetch-skate-data.js"'
            );
        }
    },
    
    /**
     * Get locations data
     */
    async getLocations() {
        const cacheKey = 'locations';
        const cached = SkateStorage.get(cacheKey);
        
        if (cached) {
            this._locations = cached;
            return cached;
        }
        
        try {
            const response = await fetch(`${this.LOCAL_DATA_PATH}/locations.json`);
            if (!response.ok) throw new Error('Not found');
            const data = await response.json();
            this._locations = data.locations || [];
            SkateStorage.set(cacheKey, this._locations);
            return this._locations;
        } catch (error) {
            console.warn('[SkateAPI] Locations file not found');
            return [];
        }
    },
    
    /**
     * Get facilities data  
     */
    async getFacilities() {
        const cacheKey = 'facilities';
        const cached = SkateStorage.get(cacheKey);
        
        if (cached) {
            this._facilities = cached;
            return cached;
        }
        
        try {
            const response = await fetch(`${this.LOCAL_DATA_PATH}/facilities.json`);
            if (!response.ok) throw new Error('Not found');
            const data = await response.json();
            this._facilities = data.facilities || [];
            SkateStorage.set(cacheKey, this._facilities);
            return this._facilities;
        } catch (error) {
            console.warn('[SkateAPI] Facilities file not found');
            return [];
        }
    },
    
    /**
     * Get metadata about the data
     */
    getMetadata() {
        return this._metadata || SkateStorage.get('skating_metadata');
    },
    
    /**
     * Check if data needs refresh
     * Returns true if data is older than 7 days
     */
    needsRefresh() {
        const metadata = this.getMetadata();
        if (!metadata?.lastUpdated) return true;
        
        const lastUpdate = new Date(metadata.lastUpdated);
        const now = new Date();
        const daysSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60 * 24);
        
        return daysSinceUpdate > 7;
    },
    
    /**
     * Clear all cached data
     * Call this before re-fetching fresh data
     */
    clearCache() {
        SkateStorage.clear('skating_programs');
        SkateStorage.clear('skating_metadata');
        SkateStorage.clear('locations');
        SkateStorage.clear('facilities');
        
        this._skatingPrograms = null;
        this._locations = null;
        this._facilities = null;
        this._metadata = null;
        
        console.log('[SkateAPI] Cache cleared');
    },
    
    /**
     * Search programs (client-side filtering)
     * Since we have all data locally, searching is instant
     */
    async searchPrograms(query) {
        const programs = await this.getSkatingPrograms();
        
        if (!query) return programs;
        
        const term = query.toLowerCase();
        return programs.filter(p => {
            const searchFields = [
                p.Activity || p['Activity Title'] || '',
                p.LocationName || p['Location Name'] || '',
                p.Category || '',
                p.Address || ''
            ];
            
            return searchFields.some(field => 
                field.toLowerCase().includes(term)
            );
        });
    }
};

// Export for browser
if (typeof window !== 'undefined') {
    window.SkateAPI = SkateAPI;
}
