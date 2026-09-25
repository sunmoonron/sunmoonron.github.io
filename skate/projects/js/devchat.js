/**
 * SkateDev — "Message the dev / report a bug": a small chat with the site
 * owner, the way a live-agent widget works on a shop site, but running on
 * the site's own Nostr relay.
 *
 *   - Messages are NIP-44-encrypted DMs (kind 4) from the visitor's device
 *     key to the owner key (SkateGuides.OWNER_PUBKEY). Nothing else sees
 *     them; the relay keeps them 90 days and then prunes (dell-nix timer).
 *   - Photos ride the same channel: shrunk in the browser (≤ 1024 px JPEG),
 *     base64-split into ≤ 40 KB chunks (a relay event is capped at 64 KB),
 *     reassembled by the reader. Videos do not fit a relay: paste a link.
 *   - The first message carries a small context line (app version, page,
 *     browser) so a bug report explains itself.
 *   - The owner sees every thread here once their device runs the owner
 *     key (Settings → Community → Import identity key); replies go back
 *     the same way and show up in the visitor's sheet with a toast.
 *
 * Community sections can stay off: opening the sheet boots the chat stack
 * (keys, relays) on demand via Actions.bootCommunity().
 */
window.SkateDev = (() => {
    'use strict';

    // ui.js may load after this file: resolve the helpers when first used
    const $ = (id) => window.SkateUI.$(id);
    const el = (...a) => window.SkateUI.el(...a);
    const Modal = { open: (id) => window.SkateUI.Modal.open(id), close: (id) => window.SkateUI.Modal.close(id) };
    const OWNER = () => window.SkateConfig?.ownerPubkey || window.SkateGuides?.OWNER_PUBKEY || '';
    const MAX_TEXT = 2000;
    const CHUNK = 40000;               // base64 chars per DM part (nip44 + relay 64 KB cap)
    const MAX_IMAGE_B64 = 420000;      // ~300 KB of JPEG, 11 parts at most

    let target = null;                 // thread pubkey being shown (owner: any; visitor: the owner)
    let pendingImage = null;           // { dataUrl, name } chosen but not sent yet
    let lastSeenCount = 0;             // for the "dev replied" toast

    const isOwner = () => window.SkateChat && SkateChat.getIdentity().pk === OWNER();
    const identityReady = () => !!(window.SkateChat && SkateChat.getIdentity().pk);
    const threadFor = (pk) => SkateChat.getState().dmThreads[pk];

    /* ---------- opening ---------- */
    async function open() {
        if (!/^[0-9a-f]{64}$/.test(OWNER())) { SkateChat?.Notify?.toast('The dev inbox is not set up yet.', 'error'); return; }
        Modal.close('settings-modal');
        Modal.open('devchat-modal');
        $('devchat-messages').innerHTML = '<div class="devchat-empty">Connecting…</div>';
        try { await window.SkateApp.Actions.bootCommunity(); } catch (e) { console.warn('[SkateDev] boot failed', e); }
        if (!identityReady()) { $('devchat-messages').innerHTML = '<div class="devchat-empty">Could not start the chat. Try again in a moment.</div>'; return; }
        if (!isOwner()) { target = OWNER(); SkateChat.startDm(OWNER(), 'The dev'); }
        else if (!target) target = firstThread();
        render();
    }

    function firstThread() {
        const th = SkateChat.getState().dmThreads;
        const pks = Object.keys(th).sort((a, b) => lastTs(th[b]) - lastTs(th[a]));
        return pks[0] || null;
    }
    const lastTs = (t) => (t.messages && t.messages.length ? t.messages[t.messages.length - 1].ts : 0);

    /* ---------- rendering ---------- */
    function render() {
        if ($('devchat-modal').classList.contains('hidden')) return;
        const st = SkateChat.getState();
        const owner = isOwner();
        $('devchat-title').textContent = owner ? 'Dev inbox' : 'Message the dev';
        $('devchat-sub').textContent = owner ? 'Every visitor thread, newest first.' : 'A bug, a wrong time, an idea. Photos welcome; videos as a link.';

        // owner: thread picker
        const picker = $('devchat-threads');
        picker.innerHTML = '';
        picker.classList.toggle('hidden', !owner);
        if (owner) {
            const pks = Object.keys(st.dmThreads).sort((a, b) => lastTs(st.dmThreads[b]) - lastTs(st.dmThreads[a]));
            if (!pks.length) picker.appendChild(el('span', { class: 'devchat-empty' }, ['No messages yet.']));
            pks.forEach(pk => {
                const t = st.dmThreads[pk];
                const unread = t.messages.filter(m => !m.mine && m.ts > (t.lastReadTs || 0)).length;
                picker.appendChild(el('button', { class: 'devchat-thread' + (pk === target ? ' active' : ''), dataset: { pk } }, [
                    `${t.name || 'Skater'} · ${pk.slice(0, 6)}`, ...(unread ? [el('span', { class: 'devchat-unread' }, [String(unread)])] : [])
                ]));
            });
        }

        const box = $('devchat-messages');
        box.innerHTML = '';
        const thread = target ? st.dmThreads[target] : null;
        const msgs = thread ? thread.messages : [];
        if (!msgs.length) {
            box.appendChild(el('div', { class: 'devchat-empty' }, [owner ? 'Pick a thread.' : 'Say hi. Replies land right here, and you get a note at the top of the schedule when one arrives.']));
        }
        msgs.forEach(m => {
            const row = el('div', { class: 'devchat-msg' + (m.mine ? ' mine' : '') + (m.status === 'failed' ? ' failed' : '') });
            if (m.type === 'image' && m.data?.src) row.appendChild(el('img', { class: 'devchat-img', src: m.data.src, alt: 'photo', loading: 'lazy' }));
            else row.appendChild(el('div', { class: 'devchat-text' }, [m.text || '']));
            if (m.data?.ctx) row.appendChild(el('div', { class: 'devchat-ctx' }, [m.data.ctx]));
            row.appendChild(el('div', { class: 'devchat-when' }, [
                new Date(m.ts).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
                m.mine ? (m.status === 'pending' ? ' · sending' : m.status === 'failed' ? ' · not sent' : ' · sent') : ''
            ]));
            box.appendChild(row);
        });
        box.scrollTop = box.scrollHeight;
        if (thread) { thread.lastReadTs = Date.now(); }
        lastSeenCount = msgs.length;

        const prev = $('devchat-preview');
        prev.innerHTML = '';
        prev.classList.toggle('hidden', !pendingImage);
        if (pendingImage) prev.append(el('img', { src: pendingImage.dataUrl, alt: '' }), el('button', { class: 'devchat-preview-x', dataset: { devRemove: '1' }, 'aria-label': 'Remove photo' }, ['✕']));
    }

    /* ---------- sending ---------- */
    function context() {
        const ua = navigator.userAgent.replace(/\s*\([^)]*\)/g, '').slice(0, 80);
        return `v${window.SkateConfig?.version || '?'} · ${location.pathname}${location.hash} · ${window.innerWidth}×${window.innerHeight} · ${ua}${window.navigator.standalone ? ' · home-screen app' : ''}`;
    }

    async function send() {
        if (!target) return;
        const ta = $('devchat-input');
        const text = ta.value.trim().slice(0, MAX_TEXT);
        if (!text && !pendingImage) return;
        const thread = threadFor(target);
        const first = !(thread && thread.messages.some(m => m.mine));
        const btn = $('devchat-send');
        btn.disabled = true;
        try {
            if (text) {
                const payload = { type: 'chat', text, fromName: SkateChat.getIdentity().name, toName: isOwner() ? (thread?.name || 'Skater') : 'The dev' };
                if (first && !isOwner()) payload.ctx = context();
                await SkateChat.sendDmTo(target, payload, text);
                ta.value = '';
            }
            if (pendingImage) {
                const img = pendingImage; pendingImage = null;
                render();
                await SkateChat.sendDmImage(target, img.dataUrl, { fromName: SkateChat.getIdentity().name });
            }
        } finally { btn.disabled = false; render(); }
    }

    /** Shrink a picked photo to ≤ 1024 px JPEG; tighter if it is still too big for the relay. */
    function shrink(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const tries = [[1024, 0.72], [900, 0.62], [720, 0.55], [600, 0.45]];
                for (const [maxSide, q] of tries) {
                    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                    const c = document.createElement('canvas');
                    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
                    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                    const dataUrl = c.toDataURL('image/jpeg', q);
                    if (dataUrl.length - dataUrl.indexOf(',') - 1 <= MAX_IMAGE_B64) return resolve(dataUrl);
                }
                reject(new Error('That photo is too large even after shrinking. Try a screenshot or a crop.'));
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo this browser can read.')); };
            img.src = url;
        });
    }

    async function pick(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { SkateChat.Notify.toast('Photos only here. For a video, paste a link in the message.', 'info', 4000); return; }
        try { pendingImage = { dataUrl: await shrink(file), name: file.name }; render(); }
        catch (e) { SkateChat.Notify.toast(e.message, 'error', 4000); }
    }

    /* ---------- wiring ---------- */
    function bind() {
        $('devchat-send').onclick = send;
        $('devchat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
        $('devchat-file').onchange = (e) => { pick(e.target.files && e.target.files[0]); e.target.value = ''; };
        $('devchat-attach').onclick = () => $('devchat-file').click();
        $('devchat-close').onclick = () => Modal.close('devchat-modal');
        $('devchat-preview').onclick = (e) => { if (e.target.closest('[data-dev-remove]')) { pendingImage = null; render(); } };
        $('devchat-threads').onclick = (e) => { const b = e.target.closest('.devchat-thread'); if (b) { target = b.dataset.pk; render(); } };
        // live updates: re-render when open, toast when a reply lands while closed
        if (window.SkateChat) SkateChat.onUpdate(onChatUpdate);
    }
    function onChatUpdate() {
        if (!$('devchat-modal').classList.contains('hidden')) { render(); return; }
        if (isOwner()) return;
        const t = threadFor(OWNER());
        if (!t) return;
        const fresh = t.messages.filter(m => !m.mine && m.ts > (t.lastReadTs || 0));
        if (fresh.length) SkateChat.Notify.toast('The dev replied. Settings → Message the dev.', 'success', 6000);
    }
    // the chat stack may boot after us: hook the update feed when it does
    function attach() { if (window.SkateChat) SkateChat.onUpdate(onChatUpdate); }

    return { open, bind, attach, render, get isOwner() { return isOwner(); } };
})();

if (typeof module !== 'undefined') module.exports = window.SkateDev;
