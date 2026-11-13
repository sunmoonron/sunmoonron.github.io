/**
 * Members' entrance (v3.11).
 *
 * One part of this site is for invited people only. This file is the only
 * piece of it that is public, and it is never loaded on an ordinary visit:
 * app.js fetches it when someone opens the #hq link, or on a device that has
 * been let in before.
 *
 * What it does, in order:
 *   1. takes the key this device already uses for chat (skate_identity_v1);
 *   2. proves that key to the home server by signing the one-time challenge
 *      the server sends (the server answers a key that is not on its list
 *      exactly as it answers garbage: with nothing);
 *   3. receives the members' app as ONE signed event, and runs it only if the
 *      signature is from the release key pinned in config.js and the build is
 *      not older than one this device has already run.
 *
 * Step 3 is why the app can come through the home server and Cloudflare at
 * all: neither can change a byte of it without the signature failing, and a
 * build that fails is never executed. A good build is kept in IndexedDB, so
 * later visits start without the network.
 *
 * Needs NostrTools (app.js loads it first). No other dependency.
 */
const SkateGate = (() => {
    const KIND_AUTH = 22242, KIND_APP = 39199;
    const IDENTITY_KEY = 'skate_identity_v1';     // shared with chat-v2.js
    const STATE_KEY = 'skate_gate_v1';            // { members: { pk: 1 }, min: highest build run here }
    const DB_NAME = 'skate-gate';
    let app = null, appPk = null, appBuild = 0, mounting = null, wantShow = false, card = null;

    const cfg = () => (window.SkateConfig && window.SkateConfig.gate) || {};
    const hexToBytes = (hex) => { const out = new Uint8Array(32); for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16); return out; };
    const bytesToHex = (b) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

    function state() {
        try {
            const s = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
            return { members: (s && typeof s.members === 'object' && s.members) || {}, min: Number.isSafeInteger(s && s.min) ? s.min : 0 };
        } catch { return { members: {}, min: 0 }; }
    }
    function saveState(s) { try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch {} }

    /** The key this device signs with. Same record the chat uses; made here if the chat never ran. */
    function identity() {
        try {
            const p = JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null');
            if (p && /^[0-9a-f]{64}$/.test(p.sk) && /^[0-9a-f]{64}$/.test(p.pk)) return { sk: hexToBytes(p.sk), pk: p.pk };
        } catch {}
        const sk = NostrTools.generateSecretKey(), pk = NostrTools.getPublicKey(sk);
        try { localStorage.setItem(IDENTITY_KEY, JSON.stringify({ sk: bytesToHex(sk), pk, name: null })); } catch {}
        return { sk, pk };
    }
    /** True when this device has been let in with its current key (no network, no key use). */
    function known() {
        try {
            const p = JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null');
            return !!(p && p.pk && state().members[p.pk]);
        } catch { return false; }
    }
    function useKey(text) {
        let hex = String(text || '').trim().replace(/\s+/g, '').toLowerCase();
        try {
            if (hex.startsWith('nsec1')) {
                const d = NostrTools.nip19.decode(hex);
                hex = typeof d.data === 'string' ? d.data : bytesToHex(d.data);
            }
        } catch { return false; }
        if (!/^[0-9a-f]{64}$/.test(hex)) return false;
        // a running chat holds the key in memory: let it switch, so both stay in step
        if (window.SkateChat && window.SkateChat.booted && window.SkateChat.importIdentity) return !!window.SkateChat.importIdentity(hex);
        let name = null;
        try { name = (JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null') || {}).name || null; } catch {}
        try { localStorage.setItem(IDENTITY_KEY, JSON.stringify({ sk: hex, pk: NostrTools.getPublicKey(hexToBytes(hex)), name })); } catch { return false; }
        return true;
    }

    /* ---------- the kept build ---------- */
    function db() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore('kv');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function kept() {
        try {
            const d = await db();
            return await new Promise((resolve) => {
                const r = d.transaction('kv', 'readonly').objectStore('kv').get('app');
                r.onsuccess = () => { d.close(); resolve(r.result || null); };
                r.onerror = () => { d.close(); resolve(null); };
            });
        } catch { return null; }
    }
    async function keep(ev) {
        try {
            const d = await db();
            await new Promise((resolve) => {
                const tx = d.transaction('kv', 'readwrite');
                if (ev) tx.objectStore('kv').put(ev, 'app'); else tx.objectStore('kv').delete('app');
                tx.oncomplete = tx.onerror = tx.onabort = () => { d.close(); resolve(); };
            });
        } catch {}
    }

    /** A build is run only if all of this holds. Returns its number, or 0. */
    function check(ev) {
        const c = cfg();
        if (!ev || typeof ev !== 'object' || ev.kind !== KIND_APP || !c.key || ev.pubkey !== c.key) return 0;
        if (typeof ev.content !== 'string' || !Array.isArray(ev.tags)) return 0;
        const d = ev.tags.find(t => Array.isArray(t) && t[0] === 'd'), v = ev.tags.find(t => Array.isArray(t) && t[0] === 'v');
        const n = v ? Number(v[1]) : NaN;
        if (!d || d[1] !== 'hq-web' || !Number.isSafeInteger(n) || n < 1 || n < state().min) return 0;
        try {
            // a fresh plain object: the library remembers "verified" on the object it checked
            const plain = { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig };
            return NostrTools.verifyEvent(plain) === true ? n : 0;
        } catch { return 0; }
    }

    /** One short connection: prove the key, ask for the build. */
    function fetchBuild(id) {
        return new Promise((resolve, reject) => {
            let ws, done = false, denied = false;
            const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} fn(v); };
            const timer = setTimeout(() => finish(reject, new Error('timeout')), 15000);
            try { ws = new WebSocket(cfg().url); } catch (e) { finish(reject, e); return; }
            ws.onmessage = (e) => {
                if (typeof e.data !== 'string') return;
                let m;
                try { m = JSON.parse(e.data); } catch { return; }
                if (!Array.isArray(m)) return;
                if (m[0] === 'AUTH' && typeof m[1] === 'string') {
                    const ev = NostrTools.finalizeEvent({ kind: KIND_AUTH, created_at: Math.floor(Date.now() / 1000), tags: [['relay', cfg().url], ['challenge', m[1]]], content: '' }, id.sk);
                    ws.send(JSON.stringify(['AUTH', { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig }]));
                } else if (m[0] === 'NO') denied = true;
                else if (m[0] === 'HELLO') ws.send(JSON.stringify(['APP', 1, 0]));
                else if (m[0] === 'R' && m[1] === 1) finish(resolve, { ev: m[2] === true ? m[3] : null });
            };
            ws.onerror = () => {};
            ws.onclose = (e) => {
                if (denied || (e && (e.code === 4003 || e.code === 4001))) finish(resolve, { denied: true });
                else finish(reject, new Error('closed'));
            };
        });
    }

    /* ---------- the entry in the top bar, shown only on a device that has been let in ---------- */
    function chip(n) {
        const btn = document.getElementById('btn-gate'), dot = document.getElementById('gate-dot');
        if (btn) btn.classList.toggle('hidden', !known());
        if (dot && typeof n === 'number') dot.classList.toggle('hidden', !(n > 0));
    }

    function run(ev, id, build) {
        const mod = new Function(ev.content)();
        const s = state();
        s.members[id.pk] = 1;
        if (build > s.min) s.min = build;
        saveState(s);
        const url = cfg().url;
        app = mod.mount({
            N: NostrTools, identity: { pk: id.pk, sk: id.sk }, url, relay: url,
            // who the members' app treats as superadmin is pinned here, in the public page, never taken from the server
            superadmins: Array.isArray(cfg().admins) && cfg().admins.length ? cfg().admins.slice() : [window.SkateConfig.devPubkey],
            idb: window.indexedDB, host: document.body, win: window,
            onUnread: (n) => chip(n),
            onHide: () => unmark(),
            wipe: () => leave('denied'),
            forget: () => leave('forgot'),
            install: async (next) => { const n = check(next); if (!n || n <= appBuild) return false; await keep(next); return true; },
            reload: () => restart()
        });
        appPk = id.pk; appBuild = build;
        chip(0);
    }
    /** The server said no (or the member chose to clear this device): nothing of the members' area stays here. */
    async function leave(why) {
        const pk = appPk, was = app;
        app = null; appPk = null; appBuild = 0;
        let wasOpen = false;
        if (was) { try { wasOpen = await was.destroy(true); } catch {} }
        const s = state();
        if (pk) delete s.members[pk];
        saveState(s);
        if (!Object.keys(s.members).length) await keep(null);
        chip(0);
        if (wasOpen || why === 'forgot') show(why, identity());
    }
    async function restart() {
        const id = identity();
        const ev = await kept(), build = check(ev);
        if (!build) return;
        const was = app;
        app = null;
        if (was) { try { await was.destroy(false); } catch {} await settle(); }
        run(ev, id, build);
        reveal();
    }

    async function start(id, quiet) {
        if (!quiet) show('busy', id);
        try {
            let ev = await kept(), build = check(ev);
            if (ev && !build) { ev = null; await keep(null); }
            if (!ev) {
                const got = await fetchBuild(id);
                if (got.denied) {
                    const s = state(); delete s.members[id.pk]; saveState(s); chip(0);
                    if (!quiet) show('denied', id);
                    return;
                }
                build = check(got.ev);
                if (!build) { if (!quiet) show(got.ev ? 'tampered' : 'down', id); return; }
                ev = got.ev;
                await keep(ev);
            }
            run(ev, id, build);
            hide();
            if (wantShow) reveal();
        } catch (e) {
            if (!quiet) show('offline', id);
        }
    }

    /* While the members' area is on screen the address says #hq, so a reload comes
       straight back to it; once it is closed the address is the plain app again. */
    function mark() { try { if (location.hash !== '#hq') history.replaceState(null, '', location.pathname + location.search + '#hq'); } catch {} }
    function unmark() {
        if (location.hash !== '#hq') return;
        const a = window.SkateApp && window.SkateApp.Actions;
        if (a && a.clearHash) a.clearHash(); else { try { history.replaceState(null, '', location.pathname + location.search); } catch {} }
    }
    function reveal() { mark(); app.show(); }

    /** A closed app unwinds its own browser-history entries; let that finish before another one opens. */
    const settle = () => new Promise((r) => setTimeout(r, 250));

    /** opts.quiet: start in the background (a device already let in), show nothing. */
    async function open(opts = {}) {
        const quiet = !!opts.quiet;
        if (!cfg().url || !cfg().key || !window.NostrTools) return;
        const id = identity();
        if (app && appPk !== id.pk) { const was = app; app = null; try { await was.destroy(false); } catch {} await settle(); }   // the key on this device changed
        if (app) { if (!quiet) reveal(); return; }
        if (!quiet) wantShow = true;
        if (mounting) return mounting;
        if (quiet && !state().members[id.pk]) return;
        if (!quiet && !state().members[id.pk]) { show('ask', id); return; }
        mounting = start(id, quiet).finally(() => { mounting = null; });
        return mounting;
    }

    /* ---------- the sign-in card ---------- */
    const TEXT = {
        ask: ['Members only', 'This part of the site is for invited people. If you were invited, continue with the key on this device.'],
        busy: ['Members only', 'Checking your key…'],
        denied: ['Not on the list', 'This key has not been added. If you were invited, send the key below to whoever invited you, then try again.'],
        offline: ['Could not connect', 'The members\' server did not answer. Check your connection and try again.'],
        down: ['Not available right now', 'The members\' area is being updated. Try again in a few minutes.'],
        tampered: ['Stopped for safety', 'The members\' app did not pass its signature check, so it was not run. Tell the site owner.'],
        forgot: ['Removed from this device', 'Everything the members\' area saved here is gone. Your key still works: open this again to come back.'],
        key: ['Use another key', 'Paste the secret key (nsec…) you were invited with. It stays on this device and replaces the chat key here.']
    };
    function hide() { if (card) { card.remove(); card = null; document.removeEventListener('keydown', onKey, true); } }
    /** the visitor dismissed the card: the link they followed is done with */
    function dismiss() { hide(); if (!app || !app.isOpen()) unmark(); }
    function onKey(e) { if (e.key === 'Escape' && card) { e.stopPropagation(); dismiss(); } }
    function show(mode, id) {
        hide();
        const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
        card = el('div', 'gate-backdrop');
        card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', TEXT[mode][0]);
        const box = el('div', 'gate-card');
        box.appendChild(el('h2', '', TEXT[mode][0]));
        box.appendChild(el('p', '', TEXT[mode][1]));
        const actions = el('div', 'gate-actions');
        const button = (label, fn, primary) => { const b = el('button', primary ? 'btn-primary' : 'btn-small', label); b.type = 'button'; b.onclick = fn; actions.appendChild(b); return b; };
        if (mode === 'key') {
            const input = el('input', 'gate-input');
            input.type = 'password'; input.autocomplete = 'off'; input.placeholder = 'nsec1…'; input.setAttribute('aria-label', 'Secret key');
            box.appendChild(input);
            const err = el('p', 'gate-error');
            box.appendChild(err);
            button('Back', () => show('ask', identity()));
            button('Use this key', () => {
                if (!useKey(input.value)) { err.textContent = 'That is not a secret key. It starts with nsec1.'; return; }
                input.value = '';
                chip();
                show('ask', identity());
            }, true);
            setTimeout(() => input.focus(), 30);
        } else {
            if (mode === 'ask' || mode === 'denied') {
                const row = el('div', 'gate-key');
                let npub = id.pk;
                try { npub = NostrTools.nip19.npubEncode(id.pk); } catch {}
                row.appendChild(el('code', '', npub));
                const copy = el('button', 'btn-small', 'Copy'); copy.type = 'button';
                copy.onclick = async () => { try { await navigator.clipboard.writeText(npub); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy'; } };
                row.appendChild(copy);
                box.appendChild(row);
            }
            button('Close', dismiss);
            if (mode === 'ask' || mode === 'denied') button('Use another key', () => show('key', id));
            if (mode === 'ask') button('Continue', () => { mounting = start(identity(), false).finally(() => { mounting = null; }); }, true);
            if (mode === 'denied' || mode === 'offline' || mode === 'down') button('Try again', () => { mounting = start(identity(), false).finally(() => { mounting = null; }); }, true);
            if (mode === 'forgot') button('Open again', () => { wantShow = true; mounting = start(identity(), false).finally(() => { mounting = null; }); }, true);
        }
        box.appendChild(actions);
        card.appendChild(box);
        card.addEventListener('click', (e) => { if (e.target === card && mode !== 'busy') dismiss(); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(card);
        const first = box.querySelector('.btn-primary') || box.querySelector('button');
        if (first && mode !== 'key') first.focus();
    }

    return { open, known, chip, get mounted() { return !!app; } };
})();

if (typeof window !== 'undefined') window.SkateGate = SkateGate;
