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

    /**
     * v3.5: pick the origin with the newer meta.json before the first load.
     * The home server can be off (power cut) or up-but-stale (its pipeline
     * failing), and a static site cannot tell those apart from "fresh"
     * without looking. Both metas are ~1 KB; unreachable remote → local;
     * remote more than an hour behind the committed copy → local.
     */
    _originChecked: false,
    async pickOrigin() {
        if (!this._dataBase || this._remoteBroken || this._originChecked) return;
        this._originChecked = true;
        const t = Date.now();
        const stamp = async (base) => {
            try {
                const opts = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? { signal: AbortSignal.timeout(6000) } : {};
                const r = await fetch(`${base}/meta.json?t=${t}`, opts);
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const j = await r.json();
                return j && j.lastUpdated ? new Date(j.lastUpdated).getTime() : null;
            } catch { return null; }
        };
        const [remote, local] = await Promise.all([stamp(this._dataBase), stamp(this.LOCAL_DATA_PATH)]);
        if (!remote) return this._fallbackLocal('meta.json unreachable');
        if (local && local - remote > 60 * 60000) this._fallbackLocal(`its copy is ${Math.round((local - remote) / 60000)} min behind the committed one`);
    },

    /** Where the home server publishes per-session .ics files (null when using the committed copies). */
    icsBase() {
        return (this._dataBase && !this._remoteBroken) ? this._dataBase.replace(/\/projects\/data$/, '') + '/ics' : null;
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
            if (force) this._originChecked = false;   // a manual refresh re-checks which origin is fresher
            await this.pickOrigin();
            const data = await this.fetchData('skating-programs.json', force);

            this._metadata = data.metadata;
            this._skatingPrograms = data.programs || [];

            console.log(`[SkateAPI] Loaded ${this._skatingPrograms.length} skating programs`);
            console.log(`[SkateAPI] Data last updated: ${this._metadata?.lastUpdated}`);

            // just the metadata (small) so the stale banner has a date before the first load
            try { localStorage.setItem('skate_meta_v1', JSON.stringify(this._metadata)); } catch { /* private mode */ }

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
        if (this._metadata) return this._metadata;
        try { return JSON.parse(localStorage.getItem('skate_meta_v1')); } catch { return null; }
    },

};

// Export for browser
if (typeof window !== 'undefined') {
    window.SkateAPI = SkateAPI;
}
