/**
 * SkateMod — message moderation + proof-of-work anti-spam.
 *
 * Profanity: three layers, cheapest first.
 *   1. Local word-boundary check against PROFANITY_LIST — instant hard block.
 *      (Word-boundary + leetspeak normalization fixes the old substring bug
 *      where innocent words like "class" or "assignment" got flagged.)
 *   2. profanity.dev  — free, open-source, POST JSON  (2.5s budget)
 *   3. PurgoMalum     — free, keyless, GET            (2.5s budget)
 *   Remote layers are best-effort: offline/API-down never blocks chatting.
 *
 * Spam: NIP-13 proof-of-work. Every publishable event must burn CPU:
 *   chat 8 bits (imperceptible), comments 12, votes 16 (~0.5-2s),
 *   guides 20 (~2-8s). A brand farming 9999 upvotes now pays 9999x that
 *   cost per throwaway key — and low-PoW events are simply not counted.
 * Mining runs in a Web Worker so the UI never freezes; falls back to a
 * chunked main-thread miner if workers are unavailable.
 */
const SkateMod = (() => {
    'use strict';

    const POW = { chat: 8, comment: 12, vote: 16, guide: 20 };
    const LEET = { '@': 'a', '$': 's', '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '!': 'i', '+': 't' };

    // ---------- Local profanity ----------
    let localRegex = null;
    function normalizeWord(w) {
        return w.toLowerCase().replace(/[@$013457!+]/g, c => LEET[c] || c);
    }
    function buildLocalRegex() {
        if (localRegex !== null) return localRegex;
        const list = (typeof window !== 'undefined' && window.PROFANITY_LIST) || [];
        if (!list.length) { localRegex = false; return localRegex; }
        const variants = new Set();
        list.filter(w => w && w.length > 2).forEach(w => {
            variants.add(w.toLowerCase());
            variants.add(normalizeWord(w)); // "2 girls 1 cup" also indexed as "2 girls i cup"
        });
        const escaped = [...variants].map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        // One compiled regex with word boundaries — built once, not per message
        localRegex = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i');
        return localRegex;
    }

    function normalize(text) {
        return text.toLowerCase().replace(/[@$013457!+]/g, c => LEET[c] || c);
    }

    function checkLocal(text) {
        const re = buildLocalRegex();
        if (!re) return false;
        return re.test(text.toLowerCase()) || re.test(normalize(text));
    }

    // ---------- Remote profanity (best-effort) ----------
    function withTimeout(promise, ms) {
        return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    }

    async function checkProfanityDev(text) {
        const res = await withTimeout(fetch('https://vector.profanity.dev', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        }), 2500);
        if (!res.ok) throw new Error('bad status');
        const data = await res.json();
        return !!data.isProfanity;
    }

    async function checkPurgoMalum(text) {
        const url = 'https://www.purgomalum.com/service/containsprofanity?text=' + encodeURIComponent(text.slice(0, 500));
        const res = await withTimeout(fetch(url), 2500);
        if (!res.ok) throw new Error('bad status');
        return (await res.text()).trim() === 'true';
    }

    /**
     * Full check. Returns { ok, reason }.
     * Local hit -> blocked immediately. Remote APIs consulted next;
     * if both are unreachable we allow (local list remains the floor).
     *
     * opts.remote=false skips the third-party APIs entirely — used for DMs
     * and private groups so private plaintext never leaves the device.
     */
    async function check(text, opts = {}) {
        const remote = opts.remote !== false;
        if (!text || !text.trim()) return { ok: false, reason: 'empty' };
        if (checkLocal(text)) return { ok: false, reason: 'local' };
        if (!remote) return { ok: true };
        try {
            if (await checkProfanityDev(text)) return { ok: false, reason: 'profanity.dev' };
            return { ok: true };
        } catch { /* fall through */ }
        try {
            if (await checkPurgoMalum(text)) return { ok: false, reason: 'purgomalum' };
        } catch { /* both remote checks unreachable: allow */ }
        return { ok: true };
    }

    /** Star out anything the local list catches (for displaying others' messages). */
    function clean(text) {
        const re = buildLocalRegex();
        if (!re || !text) return text;
        return text.replace(new RegExp(re.source, 'gi'), m => '*'.repeat(m.length));
    }

    // ---------- Proof of work (NIP-13) ----------
    /** Leading zero bits of a hex event id. */
    function getPow(hexId) {
        let bits = 0;
        for (let i = 0; i < hexId.length; i++) {
            const nibble = parseInt(hexId[i], 16);
            if (nibble === 0) { bits += 4; continue; }
            bits += Math.clz32(nibble) - 28;
            break;
        }
        return bits;
    }

    function eventPow(event) {
        // Only count PoW the author committed to (NIP-13 nonce tag target)
        const nonceTag = (event.tags || []).find(t => t[0] === 'nonce');
        const claimed = nonceTag ? parseInt(nonceTag[2] || '0', 10) : 0;
        return Math.min(getPow(event.id), claimed || getPow(event.id));
    }

    let worker = null;
    function getWorker() {
        if (worker !== null) return worker;
        try {
            const bundleUrl = new URL('../../../assets/js/nostr.bundle.js', document.currentScript?.src || location.href).href;
            const src = `importScripts(${JSON.stringify(bundleUrl)});
                onmessage = (e) => {
                    try { postMessage({ ok: true, event: NostrTools.nip13.minePow(e.data.event, e.data.bits) }); }
                    catch (err) { postMessage({ ok: false, error: String(err) }); }
                };`;
            worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
        } catch { worker = false; }
        return worker;
    }

    /**
     * Mine PoW into an unsigned event template. Resolves the mined template
     * (with nonce tag) ready for finalizeEvent(). Uses a worker when possible.
     */
    function mine(unsignedEvent, bits) {
        return new Promise((resolve, reject) => {
            const w = getWorker();
            if (w) {
                const onMsg = (e) => {
                    w.removeEventListener('message', onMsg);
                    e.data.ok ? resolve(e.data.event) : reject(new Error(e.data.error));
                };
                w.addEventListener('message', onMsg);
                w.postMessage({ event: unsignedEvent, bits });
            } else {
                // Main-thread fallback (small jank, still correct)
                try { resolve(NostrTools.nip13.minePow(unsignedEvent, bits)); }
                catch (err) { reject(err); }
            }
        });
    }

    return { check, checkLocal, clean, POW, mine, getPow, eventPow };
})();

if (typeof module !== 'undefined') module.exports = SkateMod;
