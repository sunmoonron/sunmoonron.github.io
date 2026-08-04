/**
 * SkateTour — a 20-second spotlight tour of the main controls.
 *
 * Deliberately tiny (no library): a dimmed backdrop, a glowing cutout
 * ring positioned over the current step's element, and a card with
 * Next / a BIG Skip. Steps live in SkateConfig.tourSteps (selector +
 * copy), so reordering or adding a step is config, not code.
 *
 * Edge handling: a step whose element is missing/hidden (e.g. desktop-
 * only control on mobile) is skipped automatically; reposition on
 * resize/scroll; Esc = skip; finishing or skipping both mark tourDone.
 */
window.SkateTour = (() => {
    'use strict';

    let idx = -1;
    let overlay = null, ring = null, card = null;
    let onDone = null;

    const steps = () => (window.SkateConfig?.tourSteps || []);

    function visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function build() {
        overlay = document.createElement('div');
        overlay.className = 'tour-overlay';
        ring = document.createElement('div');
        ring.className = 'tour-ring';
        card = document.createElement('div');
        card.className = 'tour-card';
        overlay.append(ring, card);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) skip(); });
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        document.addEventListener('keydown', onKey);
    }

    function onKey(e) { if (e.key === 'Escape') skip(); }

    function teardown() {
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
        document.removeEventListener('keydown', onKey);
        overlay?.remove();
        overlay = ring = card = null;
        idx = -1;
    }

    function currentTarget() {
        const s = steps()[idx];
        return s ? document.querySelector(s.sel) : null;
    }

    function reposition() {
        const el = currentTarget();
        if (!overlay || !el) return;
        const r = el.getBoundingClientRect();
        const pad = 6;
        Object.assign(ring.style, {
            left: `${r.left - pad}px`, top: `${r.top - pad}px`,
            width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`
        });
        // card below the target unless that clips off-screen, then above
        const cardH = card.offsetHeight || 150;
        const below = r.bottom + 12 + cardH < innerHeight;
        card.style.top = below ? `${r.bottom + 12}px` : `${Math.max(10, r.top - cardH - 12)}px`;
        card.style.left = `${Math.min(Math.max(10, r.left), Math.max(10, innerWidth - card.offsetWidth - 10))}px`;
    }

    function show(i) {
        const list = steps();
        // hop over steps whose element isn't on this layout
        while (i < list.length && !visible(document.querySelector(list[i].sel))) i++;
        if (i >= list.length) return finish();
        idx = i;
        const s = list[i];
        const el = document.querySelector(s.sel);
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
        card.innerHTML = `
            <button class="tour-skip">Skip tour</button>
            <h4>${s.title}</h4>
            <p>${s.text}</p>
            <div class="tour-nav">
                <span class="tour-count">${list.filter((x, j) => j <= i && visible(document.querySelector(x.sel)) || j > i).length ? `${i + 1}/${list.length}` : ''}</span>
                <button class="btn-primary tour-next">${i + 1 >= list.length ? 'Done' : 'Next'}</button>
            </div>`;
        card.querySelector('.tour-skip').onclick = skip;
        card.querySelector('.tour-next').onclick = () => show(idx + 1);
        reposition();
        requestAnimationFrame(reposition);   // after scrollIntoView settles
    }

    function markDone() {
        window.SkateSettings?.set('tourDone', true);
    }

    function finish() { markDone(); teardown(); if (onDone) onDone(); }
    function skip() { markDone(); teardown(); if (onDone) onDone(); }

    /** Start (or restart) the tour. cb fires when it ends either way. */
    function start(cb) {
        if (overlay) teardown();
        onDone = cb || null;
        build();
        show(0);
    }

    return { start, get running() { return !!overlay; } };
})();

if (typeof module !== 'undefined') module.exports = window.SkateTour;
