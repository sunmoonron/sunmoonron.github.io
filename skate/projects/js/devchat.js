/**
 * SkateDev — "Report a bug or send feedback": a small chat with the site
 * owner, the way a live-agent widget works on a shop site, but running on
 * the site's own Nostr relay.
 *
 *   - Messages are NIP-44-encrypted DMs (kind 4) from the visitor's device
 *     key to the dev key (SkateConfig.devPubkey, else ownerPubkey). Nothing
 *     else reads them; the relay prunes them after 90 days (dell-nix timer).
 *   - Screenshots and photos ride the same channel: shrunk in the browser
 *     (≤ 1024 px JPEG), base64-split into ≤ 40 KB parts (a relay event is
 *     capped at 64 KB), reassembled by the reader. On a computer, paste
 *     (Cmd/Ctrl+V) or drop the image onto the sheet. Videos: a link.
 *   - The first message carries a context line (app version, page, browser,
 *     installed or not). The visitor never sees it; the dev does.
 *   - The dev's device runs the dev key (Settings → Community → Import
 *     identity key) and sees every thread here; replies go back the same
 *     way and show up in the visitor's sheet, with a note when it is closed.
 *
 * Community sections can stay off: opening the sheet boots the chat stack
 * (keys, relays) on demand via SkateApp.Actions.bootCommunity().
 */
window.SkateDev = (() => {
    'use strict';

    // ui.js may load after this file: resolve the helpers when first used
    const $ = (id) => window.SkateUI.$(id);
    const el = (...a) => window.SkateUI.el(...a);
    const Modal = { open: (id) => window.SkateUI.Modal.open(id), close: (id) => window.SkateUI.Modal.close(id) };
    const DEV = () => window.SkateConfig?.devPubkey || window.SkateConfig?.ownerPubkey || '';
    const MAX_TEXT = 2000;
    const MAX_IMAGE_B64 = 420000;      // ~300 KB of JPEG, 11 parts at most
    const TEMPLATES = {
        wrong: 'Wrong time or rink\nRink: \nDate and time shown in the app: \nWhat is actually happening: ',
        broke: 'Something broke\nWhat I did: \nWhat happened: \nWhat I expected: ',
        idea: 'Idea\n'
    };

    let target = null;                 // thread pubkey on screen (owner: any; visitor: the dev)
    let pendingImage = null;           // { dataUrl } chosen but not sent yet
    let hooked = false;

    const isOwner = () => !!window.SkateChat && SkateChat.getIdentity().pk === DEV();
    const identityReady = () => !!(window.SkateChat && SkateChat.getIdentity().pk);
    const threadFor = (pk) => SkateChat.getState().dmThreads[pk];
    const isOpen = () => !$('devchat-modal').classList.contains('hidden');
    const lastTs = (t) => (t.messages && t.messages.length ? t.messages[t.messages.length - 1].ts : 0);
    const desktop = () => !/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1);

    /* ---------- opening ---------- */
    async function open() {
        if (!/^[0-9a-f]{64}$/.test(DEV())) { window.SkateChat?.Notify?.toast('The dev inbox is not set up yet.', 'error'); return; }
        Modal.close('settings-modal');
        Modal.open('devchat-modal');
        $('devchat-messages').innerHTML = '<div class="devchat-empty">Connecting…</div>';
        try { await window.SkateApp.Actions.bootCommunity(); } catch (e) { console.warn('[SkateDev] boot failed', e); }
        attach();
        if (!identityReady()) { $('devchat-messages').innerHTML = '<div class="devchat-empty">Could not start the chat. Check the connection and try again.</div>'; return; }
        if (!isOwner()) { target = DEV(); SkateChat.startDm(DEV(), 'The dev'); }
        else if (!target) target = firstThread();
        render();
        if (desktop()) setTimeout(() => $('devchat-input').focus(), 50);
    }

    function firstThread() {
        const th = SkateChat.getState().dmThreads;
        return Object.keys(th).sort((a, b) => lastTs(th[b]) - lastTs(th[a]))[0] || null;
    }

    /* ---------- rendering ---------- */
    function render() {
        if (!isOpen()) return;
        const st = SkateChat.getState();
        const owner = isOwner();
        $('devchat-title').textContent = owner ? 'Dev inbox' : 'Report a bug or send feedback';
        $('devchat-sub').textContent = owner ? 'Every visitor thread, newest first.' : 'Straight to the dev, private, kept 90 days.';

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
            if (owner) box.appendChild(el('div', { class: 'devchat-empty' }, ['Pick a thread.']));
            else box.appendChild(el('div', { class: 'devchat-intro' }, [
                el('p', {}, ['Wrong time, wrong rink, a button that does nothing, or an idea: say it here. A screenshot helps.']),
                el('div', { class: 'devchat-chips' }, [
                    el('button', { class: 'devchat-chip', dataset: { tpl: 'wrong' } }, ['Wrong time or rink']),
                    el('button', { class: 'devchat-chip', dataset: { tpl: 'broke' } }, ['Something broke']),
                    el('button', { class: 'devchat-chip', dataset: { tpl: 'idea' } }, ['An idea'])
                ]),
                el('p', { class: 'devchat-note' }, ['Replies show up right here, and as a note at the top of the schedule while this is closed.'])
            ]));
        }
        msgs.forEach(m => {
            const row = el('div', { class: 'devchat-msg' + (m.mine ? ' mine' : '') + (m.status === 'failed' ? ' failed' : '') });
            if (m.type === 'image' && m.data?.src) row.appendChild(el('img', { class: 'devchat-img', src: m.data.src, alt: 'photo', loading: 'lazy' }));
            else row.appendChild(el('div', { class: 'devchat-text' }, [m.text || '']));
            if (owner && m.data?.ctx) row.appendChild(el('div', { class: 'devchat-ctx' }, [m.data.ctx]));
            row.appendChild(el('div', { class: 'devchat-when' }, [
                new Date(m.ts).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
                m.mine ? (m.status === 'pending' ? ' · sending' : m.status === 'failed' ? ' · not sent, tap Send again' : ' · sent') : ''
            ]));
            box.appendChild(row);
        });
        box.scrollTop = box.scrollHeight;
        if (thread) thread.lastReadTs = Date.now();

        const prev = $('devchat-preview');
        prev.innerHTML = '';
        prev.classList.toggle('hidden', !pendingImage);
        if (pendingImage) prev.append(el('img', { src: pendingImage.dataUrl, alt: '' }), el('span', { class: 'devchat-preview-name' }, ['Screenshot attached']), el('button', { class: 'devchat-preview-x', dataset: { devRemove: '1' }, 'aria-label': 'Remove the photo' }, ['✕']));
        $('devchat-tip').textContent = desktop() ? 'Paste (Cmd/Ctrl+V) or drop a screenshot here.' : 'Photos are shrunk before sending.';
        syncSend();
    }

    function syncSend() {
        const has = !!($('devchat-input').value.trim() || pendingImage);
        $('devchat-send').disabled = !has || !target;
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
        let ok = true;
        try {
            if (text) {
                const payload = { type: 'chat', text, fromName: SkateChat.getIdentity().name, toName: isOwner() ? (thread?.name || 'Skater') : 'The dev' };
                if (first && !isOwner()) payload.ctx = context();
                ok = await SkateChat.sendDmTo(target, payload, text) && ok;
                ta.value = '';
            }
            if (pendingImage) {
                const img = pendingImage; pendingImage = null;
                render();
                ok = await SkateChat.sendDmImage(target, img.dataUrl, { fromName: SkateChat.getIdentity().name }) && ok;
            }
        } finally { render(); }
        if (!isOwner()) SkateChat.Notify.toast(ok ? 'Sent to the dev. Replies land in this sheet.' : 'Could not reach the relay. Your message is kept here, tap Send again later.', ok ? 'success' : 'error', 4000);
    }

    /** Shrink a picked image to ≤ 1024 px JPEG; tighter if it is still too big for the relay. */
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
                reject(new Error('That image is too large even after shrinking. Try a crop.'));
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image this browser can read.')); };
            img.src = url;
        });
    }

    async function pick(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { SkateChat.Notify.toast('Images only here. For a video, paste a link in the message.', 'info', 4000); return; }
        try { pendingImage = { dataUrl: await shrink(file) }; render(); }
        catch (e) { SkateChat.Notify.toast(e.message, 'error', 4000); }
    }

    /* ---------- wiring ---------- */
    function bind() {
        const input = $('devchat-input');
        $('devchat-send').onclick = send;
        input.addEventListener('input', syncSend);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
        $('devchat-file').onchange = (e) => { pick(e.target.files && e.target.files[0]); e.target.value = ''; };
        $('devchat-attach').onclick = () => $('devchat-file').click();
        $('devchat-close').onclick = () => Modal.close('devchat-modal');
        $('devchat-preview').onclick = (e) => { if (e.target.closest('[data-dev-remove]')) { pendingImage = null; render(); } };
        $('devchat-threads').onclick = (e) => { const b = e.target.closest('.devchat-thread'); if (b) { target = b.dataset.pk; render(); } };
        $('devchat-messages').onclick = (e) => {
            const chip = e.target.closest('[data-tpl]');
            if (!chip) return;
            input.value = TEMPLATES[chip.dataset.tpl] || '';
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            syncSend();
        };
        // computer: paste or drop a screenshot anywhere on the sheet
        const box = $('devchat-box');
        let dragDepth = 0;
        box.addEventListener('dragenter', (e) => { if (!e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); dragDepth++; $('devchat-drop').hidden = false; });
        box.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
        box.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('devchat-drop').hidden = true; } });
        box.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('devchat-drop').hidden = true; pick(e.dataTransfer?.files?.[0]); });
        document.addEventListener('paste', (e) => {
            if (!isOpen()) return;
            const item = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && /^image\//.test(i.type));
            if (item) { e.preventDefault(); pick(item.getAsFile()); }
        });
        attach();
    }

    function onChatUpdate() {
        if (isOpen()) { render(); return; }
        if (isOwner()) return;
        const t = threadFor(DEV());
        if (!t) return;
        if (t.messages.some(m => !m.mine && m.ts > (t.lastReadTs || 0))) SkateChat.Notify.toast('The dev replied. Tap Report bug or feedback in the top bar.', 'success', 6000);
    }
    /** The chat stack may boot after us: hook its update feed once it exists. */
    function attach() { if (!hooked && window.SkateChat) { hooked = true; SkateChat.onUpdate(onChatUpdate); } }

    return { open, bind, attach, render, get isOwner() { return isOwner(); } };
})();

if (typeof module !== 'undefined') module.exports = window.SkateDev;
