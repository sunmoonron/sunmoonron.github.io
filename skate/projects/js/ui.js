/**
 * SkateUI — reusable, parameterized DOM + formatting utilities.
 *
 * Consolidates what used to be ~12 near-duplicate blocks in the inline
 * app script: three hand-rolled filter-chip groups, two popover builders,
 * scattered modal open/close calls, repeated escape/clipboard/date code.
 *
 * Everything renders through either `el()` (textContent-safe DOM building
 * for user-generated strings) or template literals passed through
 * `escapeHtml` — no user string ever lands in an inline handler.
 */
window.SkateUI = (() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const $$ = sel => document.querySelectorAll(sel);

    /* ---------- text / formatting ---------- */
    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function parseLocalDate(str) {
        if (!str) return new Date(9999, 0, 1);
        const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
        return new Date(str);
    }
    function mapsUrl(location) {
        return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(location + ', Toronto, ON');
    }

    /* ---------- identity visuals ---------- */
    /** Deterministic hue per pubkey — tiny colored dot so "Skater" ≠ "Skater". */
    function hueOf(pubkey) {
        if (!pubkey) return 200;
        return parseInt(pubkey.slice(0, 6), 16) % 360;
    }
    function hueDot(pubkey) {
        return `<span class="hue-dot" style="--hue:${hueOf(pubkey)}"></span>`;
    }
    function shortPk(pubkey) { return pubkey ? '#' + pubkey.slice(0, 6) : ''; }

    /* ---------- DOM builder (textContent-safe) ---------- */
    /**
     * el('button', { class:'x', dataset:{pk}, onclick, title }, ['text', node])
     * Strings become text nodes — user content can never inject markup.
     */
    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null) continue;
            if (k === 'class') node.className = v;
            else if (k === 'dataset') Object.assign(node.dataset, v);
            else if (k === 'html') node.innerHTML = v;            // caller-escaped only
            else if (k.startsWith('on')) node[k] = v;
            else node.setAttribute(k, v);
        }
        for (const c of [].concat(children)) {
            if (c == null) continue;
            node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        return node;
    }

    /* ---------- clipboard (with execCommand fallback) ---------- */
    function copyText(text, okMsg = 'Copied! 📋') {
        const toast = (m, t) => window.SkateChat?.Notify.toast(m, t, t === 'error' ? 4000 : 2000);
        const fallback = () => {
            try {
                const ta = el('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;opacity:0';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                ta.remove();
                ok ? toast(okMsg, 'success') : toast('Could not copy — long-press to copy manually', 'error');
            } catch { toast('Could not copy', 'error'); }
        };
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(() => toast(okMsg, 'success')).catch(fallback);
        } else fallback();
    }

    /* ---------- scroll-to + flash highlight ---------- */
    function flash(node) {
        if (!node) return;
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        node.classList.add('flash');
        node.addEventListener('animationend', () => node.classList.remove('flash'), { once: true });
    }

    /* ---------- filter-chip groups ----------
       One parameterized builder replaces the three hand-rolled groups
       (program types, chat filters, guide categories). Emits the exact
       markup contract: <button class="filter-chip" data-<attr>="id">. */
    function chips(container, items, { attr, active, onPick, extra }) {
        container.innerHTML = '';
        items.forEach(it => {
            const btn = el('button', {
                class: 'filter-chip' + (it.id === active ? ' active' : ''),
                dataset: { [attr]: it.id },
                ...(it.chipId ? { id: it.chipId } : {})
            });
            btn.append(document.createTextNode(it.label));
            if (it.badgeId) btn.appendChild(el('span', { class: 'chip-badge hidden', id: it.badgeId }));
            if (extra) extra(btn, it);
            container.appendChild(btn);
        });
        container.onclick = e => {
            const chip = e.target.closest('.filter-chip');
            if (!chip) return;
            $$(`#${container.id} .filter-chip`).forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            onPick(chip.dataset[attr]);
        };
    }

    function fillSelect(select, values, labelFn = v => v) {
        values.forEach(v => select.appendChild(el('option', typeof v === 'object' ? { value: v.value } : {}, [labelFn(v)])));
    }

    /* ---------- popover (context menus) ---------- */
    const Popover = {
        close() {
            const p = $('popover');
            p.classList.add('hidden');
            p.innerHTML = '';
        },
        /** items: [{label, danger?, onClick}] — built with textContent, never innerHTML. */
        open(anchor, items) {
            if (!items.length) return;
            const p = $('popover');
            p.innerHTML = '';
            items.forEach(it => {
                p.appendChild(el('button', {
                    class: 'popover-item' + (it.danger ? ' danger' : ''),
                    onclick: (e) => { e.stopPropagation(); Popover.close(); it.onClick(); }
                }, [it.label]));
            });
            p.classList.remove('hidden');
            const r = anchor.getBoundingClientRect();
            const pw = Math.min(240, window.innerWidth - 16);
            p.style.left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8) + 'px';
            p.style.top = (r.bottom + 6) + 'px';
            const ph = p.offsetHeight;
            if (r.bottom + 6 + ph > window.innerHeight - 8) p.style.top = Math.max(8, r.top - ph - 6) + 'px';
        },
        isOpen() { return !$('popover').classList.contains('hidden'); }
    };
    document.addEventListener('click', e => {
        if (!e.target.closest('#popover')) Popover.close();
    }, true);
    window.addEventListener('scroll', Popover.close, true);
    window.addEventListener('resize', Popover.close);

    /* ---------- modals ---------- */
    const Modal = {
        open(id) { $(id).classList.remove('hidden'); },
        close(id) { $(id).classList.add('hidden'); },
        any() { return [...$$('.modal-overlay')].find(m => !m.classList.contains('hidden')) || null; },
        /** Click-outside closes any modal except onboarding; onDismiss(id) hook. */
        bindOverlays(onDismiss) {
            $$('.modal-overlay').forEach(m => m.addEventListener('click', e => {
                if (e.target === m && m.id !== 'onboarding-modal') {
                    m.classList.add('hidden');
                    if (onDismiss) onDismiss(m.id);
                }
            }));
        }
    };

    /* ---------- event delegation ----------
       One listener per container; the table maps a closest()-selector to a
       handler. First match wins. Handlers receive (hitElement, event). */
    function delegate(container, table) {
        container.onclick = e => {
            for (const [sel, handler] of table) {
                const hit = e.target.closest(sel);
                if (hit && container.contains(hit)) return handler(hit, e);
            }
        };
    }

    return { $, $$, escapeHtml, parseLocalDate, mapsUrl, hueOf, hueDot, shortPk, el, copyText, flash, chips, fillSelect, Popover, Modal, delegate };
})();

if (typeof module !== 'undefined') module.exports = window.SkateUI;
