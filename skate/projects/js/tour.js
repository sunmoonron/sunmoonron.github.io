/**
 * SkateTour — a spotlight tour of the main controls, two ways:
 *   start() — the quick tour: tap Next through the steps (~20 s)
 *   play()  — the guide: auto-advances like a screencast (~60 s), with a
 *             progress bar, Pause/Resume, and the same big Skip.
 *
 * Deliberately tiny (no library): a dimmed backdrop, a glowing cutout
 * ring positioned over the current step's element, and a card with
 * Next / a BIG Skip. Steps live in SkateConfig.tourSteps (selector +
 * copy + `sec` for the guide), so reordering or adding a step is config,
 * not code.
 *
 * Edge handling: a step whose element is missing/hidden (e.g. desktop-
 * only control on mobile) is skipped automatically; reposition on
 * resize/scroll; Esc = skip; finishing or skipping both mark tourDone.
 * Skip always outranks everything: first button in the card, Esc, and a
 * tap on the backdrop.
 */
window.SkateTour = (() => {
    'use strict';

    let idx = -1;
    let overlay = null, ring = null, card = null;
    let onDone = null;
    let auto = false;            // play() mode
    let paused = false;
    let timer = null, tickTimer = null, stepStartedAt = 0, stepDur = 0, remaining = 0;

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

    function clearTimers() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    function teardown() {
        clearTimers();
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
        document.removeEventListener('keydown', onKey);
        overlay?.remove();
        overlay = ring = card = null;
        idx = -1;
        auto = false; paused = false;
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

    /** Steps that exist on this layout (hidden targets are skipped). */
    function visibleSteps() { return steps().filter(s => visible(document.querySelector(s.sel))); }

    function show(i) {
        clearTimers();
        const list = steps();
        // hop over steps whose element isn't on this layout
        while (i < list.length && !visible(document.querySelector(list[i].sel))) i++;
        if (i >= list.length) return finish();
        idx = i;
        const s = list[i];
        const el = document.querySelector(s.sel);
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
        const vis = visibleSteps();
        const pos = vis.indexOf(s) + 1;
        const last = pos >= vis.length;
        card.innerHTML = `
            <button class="tour-skip">${auto ? 'Skip guide' : 'Skip tour'}</button>
            ${auto ? '<div class="tour-progress"><div class="tour-progress-bar"></div></div>' : ''}
            <h4>${s.title}</h4>
            <p>${s.text}</p>
            <div class="tour-nav">
                <span class="tour-count">${pos}/${vis.length}</span>
                <span class="tour-nav-btns">
                    ${auto ? '<button class="tour-pause" aria-label="Pause">⏸ Pause</button>' : ''}
                    <button class="btn-primary tour-next">${last ? 'Done' : 'Next'}</button>
                </span>
            </div>`;
        card.querySelector('.tour-skip').onclick = skip;
        card.querySelector('.tour-next').onclick = () => show(idx + 1);
        if (auto) {
            card.querySelector('.tour-pause').onclick = togglePause;
            paused = false;
            stepDur = (s.sec || 5) * 1000;
            remaining = stepDur;
            armStep();
        }
        reposition();
        requestAnimationFrame(reposition);   // after scrollIntoView settles
    }

    /* ---- auto-play plumbing ---- */
    function armStep() {
        clearTimers();
        stepStartedAt = Date.now();
        timer = setTimeout(() => show(idx + 1), remaining);
        tickTimer = setInterval(paint, 100);
        paint();
    }
    function paint() {
        const bar = card?.querySelector('.tour-progress-bar');
        if (!bar) return;
        const elapsed = paused ? (stepDur - remaining) : (stepDur - remaining) + (Date.now() - stepStartedAt);
        bar.style.width = `${Math.min(100, (elapsed / stepDur) * 100)}%`;
    }
    function togglePause() {
        const btn = card?.querySelector('.tour-pause');
        if (!paused) {
            remaining = Math.max(0, remaining - (Date.now() - stepStartedAt));
            clearTimers();
            paused = true;
            if (btn) btn.textContent = '▶ Resume';
        } else {
            paused = false;
            if (btn) btn.textContent = '⏸ Pause';
            armStep();
        }
    }

    function markDone() {
        window.SkateSettings?.set('tourDone', true);
    }

    function finish() { markDone(); teardown(); if (onDone) onDone(); }
    function skip() { markDone(); teardown(); if (onDone) onDone(); }

    /** Start (or restart) the quick tour. cb fires when it ends either way. */
    function start(cb) {
        if (overlay) teardown();
        onDone = cb || null;
        auto = false;
        build();
        show(0);
    }

    /** The auto-playing guide (~60 s): same steps, advances on its own. */
    function play(cb) {
        if (overlay) teardown();
        onDone = cb || null;
        auto = true;
        build();
        show(0);
    }

    /** Total guide length in seconds for the visible steps (Settings label). */
    function duration() { return visibleSteps().reduce((n, s) => n + (s.sec || 5), 0); }

    return { start, play, duration, get running() { return !!overlay; } };
})();

if (typeof module !== 'undefined') module.exports = window.SkateTour;
