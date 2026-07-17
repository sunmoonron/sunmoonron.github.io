/**
 * API Module - Loads the CI-committed skating data from projects/data/.
 *
 * Data is refreshed by GitHub Actions (weekly full run + the 30-min
 * refresh-listener); the browser just fetches the static JSON. The old
 * Firebase Storage path and the locations/facilities loaders were dead
 * weight (nothing called them; the files were stale in the repo) and
 * were removed in v2.2.
 */

const SkateAPI = {
    // Local static data files (relative to skate/index.html)
    LOCAL_DATA_PATH: 'projects/data',

    // Cached data
    _skatingPrograms: null,
    _metadata: null,

    /**
     * Fetch a JSON data file.
     * Cache-busted in 10-minute buckets: without a query param the
     * browser's HTTP cache (heuristic locally, max-age=600 on GH Pages)
     * can keep serving pre-update data even across reloads. `force`
     * (the 🔄 button) busts with a unique value.
     */
    async fetchData(filename, force = false) {
        const bust = force ? Date.now() : Math.floor(Date.now() / 600000);
        const localUrl = `${this.LOCAL_DATA_PATH}/${filename}?t=${bust}`;
        console.log(`[SkateAPI] Loading: ${localUrl}`);

        const response = await fetch(localUrl);
        if (!response.ok) {
            throw new Error(`Failed to load ${filename}: ${response.status}`);
        }

        return response.json();
    },

    /**
     * Get skating programs — the main method the UI calls.
     */
    async getSkatingPrograms(force = false) {
        if (this._skatingPrograms) {
            console.log(`[SkateAPI] Using memory cache: ${this._skatingPrograms.length} programs`);
            return this._skatingPrograms;
        }

        try {
            const data = await this.fetchData('skating-programs.json', force);

            this._metadata = data.metadata;
            this._skatingPrograms = data.programs || [];

            console.log(`[SkateAPI] Loaded ${this._skatingPrograms.length} skating programs`);
            console.log(`[SkateAPI] Data last updated: ${this._metadata?.lastUpdated}`);

            // Store just metadata in localStorage (small)
            SkateStorage.set('skating_metadata', this._metadata);

            return this._skatingPrograms;

        } catch (error) {
            console.error('[SkateAPI] Failed to load skating programs:', error);
            throw new Error(
                'Skating data not found. If you are self-hosting, run "node fetch-skate-data.js" first.'
            );
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

        this._skatingPrograms = null;
        this._metadata = null;

        console.log('[SkateAPI] Cache cleared');
    }
};

// Export for browser
if (typeof window !== 'undefined') {
    window.SkateAPI = SkateAPI;
}
