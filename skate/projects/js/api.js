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

    // Optional alternate origin for the data JSONs (v3.1). The planned home
    // server (Dell) can serve fresher copies of the same files; the
    // committed same-origin copies stay the fallback (and the offline copy —
    // sw.js never caches cross-origin). Set via SkateConfig.dataBase or
    // SkateAPI.configure({ dataBase: 'https://…/skate-data' }) before boot.
    // Any failure on the remote origin falls back to same-origin for the
    // rest of the session.
    _dataBase: (typeof window !== 'undefined' && window.SkateConfig?.dataBase) || null,
    _remoteBroken: false,

    configure({ dataBase } = {}) {
        if (dataBase !== undefined) this._dataBase = dataBase ? String(dataBase).replace(/\/+$/, '') : null;
        this._remoteBroken = false;
    },

    /**
     * URL for a data file (relative path like 'projects/data/alerts.json' or
     * a bare filename), with the caller's cache-bust token. Every data
     * consumer (programs, alerts, rinks, meta, live check) routes through
     * here so a single setting swaps the data source for the whole app.
     */
    dataUrl(file, bust = Math.floor(Date.now() / 600000)) {
        const name = String(file).replace(/^projects\/data\//, '');
        const base = (this._dataBase && !this._remoteBroken) ? this._dataBase : this.LOCAL_DATA_PATH;
        return `${base}/${name}?t=${bust}`;
    },

    /** Remote data origin failed → same-origin for the rest of the session. */
    _fallbackLocal(reason) {
        if (this._dataBase && !this._remoteBroken) {
            this._remoteBroken = true;
            console.warn(`[SkateAPI] data origin ${this._dataBase} failed (${reason}) — using committed copies`);
        }
    },

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
        let url = this.dataUrl(filename, bust);
        console.log(`[SkateAPI] Loading: ${url}`);

        let response;
        try {
            response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch (e) {
            // remote origin down/CORS-blocked → retry the committed copy once
            if (this._dataBase && !this._remoteBroken) {
                this._fallbackLocal(e.message);
                url = this.dataUrl(filename, bust);
                response = await fetch(url);
                if (!response.ok) throw new Error(`Failed to load ${filename}: ${response.status}`);
            } else {
                throw new Error(`Failed to load ${filename}: ${e.message}`);
            }
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
