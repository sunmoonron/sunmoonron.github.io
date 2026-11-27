/**
 * The blue jay (v3.20): a small drawn bird that perches beside the title.
 *
 *  - Our own drawing (plain SVG shapes, about 3 KB), no library, no image request.
 *  - It blinks and tilts its head now and then (CSS only, on transform). With
 *    "reduce motion" on, it sits still and never flies.
 *  - Tap it for a short menu: a tip, the temperature in its own words, a blue jay
 *    fact, or feed it. What it says shows in a speech bubble (announced politely
 *    to screen readers) that goes away by itself or on a tap.
 *  - During the first-time guide it flies from step to step and lands on the
 *    guide's card; when the guide ends or is skipped it flies home to its perch.
 *    (tour.js calls SkateBird.guide(card) and SkateBird.home().)
 *
 *  - v3.21: now and then, when nothing else is going on, it does something by itself: an arc
 *    out to the switch or the end of the title and back (when there is room above the bar to land),
 *    a lap along the bar, hops, a preen, a look behind, a song, a shiver when it is very cold.
 *    It sleeps from 10 pm to 6 am, and cheers when a session is saved. "Sit still" in its menu
 *    stops all of it (the only thing it remembers, on this device).
 *
 * Nothing here reads or stores anything about the visitor.
 */
window.SkateBird = (() => {
    const SVG = `
<svg class="jay-svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <path class="jay-twig" d="M19 57.4C28 55.9 40 55.9 51 57.8M44.5 56.7l4.6-3.3"/>
  <g class="jay-bird">
    <g class="jay-tail">
      <path class="jay-deep" d="M19 42.5 5.2 57.2c-.7 1.2.1 2.7 1.6 2.7l5.6-.3 13.2-11.2z"/>
      <path class="jay-white" d="M5.2 57.2c-.7 1.2.1 2.7 1.6 2.7l3.8-.2-3-5z"/>
      <path class="jay-bars" d="M14.6 50l4.2 3.2M10.9 53.8l4 3.1"/>
    </g>
    <path class="jay-legs" d="M31.5 50 31 55.4M36.6 49.4l.8 6M28.6 56h5M35 56h5"/>
    <path class="jay-blue" d="M36 26c-8 0-17 6-17.500 15-.3 5 4.500 9.500 12.500 9.500 9 0 16.500-6.500 16.500-15.500 0-4-2.500-7-5.500-8z"/>
    <path class="jay-white jay-edge" d="M47.300 35.500c0 8.500-7.300 14.700-16.300 14.700-3.500 0-6.400-1-8.400-2.600 8.400.2 15.900-4.600 17.900-13.600.500-2.800 3-4.600 5.500-3.400.900 1.400 1.300 3.100 1.300 4.900z"/>
    <g class="jay-wing">
      <path class="jay-deep" d="M37 29.500c-6.500-2-14.500 1.500-17.400 10-.8 3-.2 5.500 1.400 6.700 8-.2 15.500-5.200 18.200-12.700.1-2-.7-3.300-2.200-4z"/>
      <path class="jay-shine" d="M36.500 31c-5-1.200-10.500.8-13.500 5"/>
      <path class="jay-bar-white" d="M26.500 41.800c3.500-.8 6.700-3 8.700-5.800"/>
      <path class="jay-bars" d="M22.200 41.200l3-1.900M23.800 44.200l3.400-2M21.200 37.600l2.600-1.700"/>
    </g>
    <g class="jay-head">
      <circle class="jay-white jay-edge" cx="44" cy="21" r="9.600"/>
      <path class="jay-blue" d="M52.800 17.400c-2.200-4.800-6.800-7.200-11.600-6.500-3.200-2.200-7.400-3.700-11.700-3.700 1.900 2.200 3.200 4.900 3.900 7.800 0 2.800.4 5.400 1.500 7.800 3.700-4 10.500-6.200 17.900-5.400z"/>
      <path class="jay-crest-line" d="M32 9.200c2.200 1.800 3.700 4 4.500 6.400"/>
      <path class="jay-collar" d="M35 21.600c.2 5.600 4.400 9.800 10.600 9.600 1.800-.1 3.300-.8 4.400-2"/>
      <path class="jay-bars" d="M48.600 21l4.300.4"/>
      <g class="jay-eye"><circle class="jay-ink" cx="46.600" cy="20.400" r="1.750"/><circle class="jay-white" cx="47.200" cy="19.800" r=".55"/></g>
      <path class="jay-beak" d="M52.600 19.200 60 21.900l-7.200 2.500c-.6-1.700-.6-3.500-.2-5.200z"/>
    </g>
  </g>
</svg>`;

    const TIPS = [
        'Tap the day on the bar to jump to another day.',
        'Tap the date on the bar for a calendar: one day, or a range.',
        'The heart saves a session. Saved ones come back up top.',
        'Outdoor rinks close in warm or wet weather. Check before you go.',
        'No skates? Look for the free skates tag on a session.',
        'The All and Free switch hides everything that costs money.',
        'Rinks & map shows what is close to you.',
        'Bend your knees a little. It is easier to balance.',
        'Dull skates slip. Most arenas sharpen them in a few minutes.',
        'A helmet is a good idea for everyone, and a rule for small kids at many rinks.'
    ];
    const FACTS = [
        'My feathers are not really blue. There is no blue in them at all: it is the way they scatter light.',
        'I can carry five acorns at once, and I hide thousands every fall.',
        'I can copy the call of a hawk. It clears the bird feeder nicely.',
        'My crest shows my mood: up when I am excited, flat when I am calm.',
        'Crows and ravens are my cousins.',
        'Some of us stay in Ontario all winter and some fly south. Nobody knows how we choose.',
        'Blue jays often stay with one partner for life.',
        'I am the provincial bird of Prince Edward Island.'
    ];
    const FED = ['Mmm, a sunflower seed. Thank you!', 'Peanuts are my favourite.', 'Crunch. I will hide the next one for winter.', 'I am full. Go skate!'];

    const reduce = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const turn = { tip: 0, fact: 0, fed: 0 };
    let btn = null, bubble = null, flyer = null, hideTimer = 0, homeTimer = 0, atHome = true;

    /** The words for the temperature, from the weather the app already has (none: it says so). */
    function weatherLine() {
        const w = window.SkateWeather && SkateWeather.current;
        if (!w || !Number.isFinite(Number(w.temp))) return 'I cannot see the sky right now. Try me again in a moment.';
        const t = Math.round(Number(w.temp)), f = Number.isFinite(Number(w.feels)) ? Math.round(Number(w.feels)) : t;
        const where = w.label && !/^my location$/i.test(w.label) ? ` in ${w.label}` : '';
        const base = `${t}°${where}${f !== t ? `, feels like ${f}°` : ''}.`;
        if (f <= -15) return `${base} That is cold even for me. Cover your face!`;
        if (f <= -5) return `${base} Mittens and a hat.`;
        if (t <= 2) return `${base} Good ice weather.`;
        if (t <= 8) return `${base} Outdoor ice goes soft when it is this mild. Check the rink first.`;
        return `${base} Too warm for outdoor ice. An indoor arena is the safe bet.`;
    }

    function say(text) {
        if (!bubble || !btn) return;
        clearTimeout(hideTimer);
        bubble.textContent = text;
        const r = btn.getBoundingClientRect();
        bubble.style.top = `${Math.round(r.bottom + 8)}px`;
        bubble.style.left = `${Math.max(8, Math.round(r.left))}px`;
        bubble.classList.remove('hidden');
        hideTimer = setTimeout(hush, Math.min(12000, 4000 + text.length * 55));
    }
    function hush() { clearTimeout(hideTimer); if (bubble) bubble.classList.add('hidden'); }

    function once(el, cls, ms) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), ms); }

    /* ---- a life of its own (v3.21): now and then it does something by itself ---- */
    const still = () => !!(window.SkateSettings && SkateSettings.get('birdStill') === true);
    let tempo = 1, busy = false, anim = null, actTimer = 0, lastAct = '', awakeUntil = 0;
    const T = (ms) => Math.max(1, ms * tempo);
    const wait = (ms) => new Promise(r => setTimeout(r, T(ms)));

    function menu() {
        const next = (list, key) => list[turn[key]++ % list.length];
        return [
            { label: 'A tip', onClick: () => say(next(TIPS, 'tip')) },
            { label: 'How cold is it?', onClick: () => say(weatherLine()) },
            { label: 'A blue jay fact', onClick: () => say(next(FACTS, 'fact')) },
            { label: 'Feed the bird', onClick: () => { if (!reduce()) once(btn, 'pecking', 1300); say(FED[Math.min(turn.fed++, FED.length - 1)]); } },
            still()
                ? { label: 'Fly around again', onClick: () => { setStill(false); say('Thank you. I was getting stiff.'); } }
                : { label: 'Sit still', onClick: () => { setStill(true); say('I will sit still. Tap me if you change your mind.'); } }
        ];
    }
    /** "Sit still": no flying, no fidgeting, until asked again. Remembered on this device. */
    function setStill(v) {
        if (window.SkateSettings) SkateSettings.set('birdStill', !!v);
        if (v) { stopAct(); clearTimeout(actTimer); } else schedule(true);
        mood();
    }
    /** Still, asleep (10 pm to 6 am, unless just woken by a tap) or neither: the styles go by these. */
    function mood(hour) {
        if (!btn) return;
        const h = Number.isInteger(hour) ? hour : new Date().getHours();
        btn.classList.toggle('still', still());
        btn.classList.toggle('asleep', !still() && (h >= 22 || h < 6) && Date.now() > awakeUntil);
    }

    /* ---- flying ---- */
    function ensureFlyer() {
        if (flyer) return flyer;
        flyer = document.createElement('div');
        flyer.className = 'jay-flyer hidden';
        flyer.setAttribute('aria-hidden', 'true');
        flyer.innerHTML = `<div class="jay-flip">${SVG}</div>`;
        document.body.appendChild(flyer);
        return flyer;
    }
    const SIZE = 34;
    function place(x, y, fly) {
        const f = ensureFlyer();
        const from = f._at || { x, y };
        f.classList.toggle('left', x < from.x - 2);          // face the way it flies
        f._at = { x, y };
        if (fly) {
            f.classList.add('flying');
            clearTimeout(f._land);
            f._land = setTimeout(() => f.classList.remove('flying', 'left'), 900);
        }
        f.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    }
    const homeSpot = () => { const r = btn.getBoundingClientRect(); return { x: r.left + (r.width - SIZE) / 2, y: r.top + (r.height - SIZE) / 2 }; };

    /** Leave the perch: the flying copy appears exactly over the perched bird, which hides (its twig stays). */
    function takeOff() {
        const f = ensureFlyer(), h = homeSpot();
        atHome = false;
        clearTimeout(f._land);
        f.classList.add('no-move');
        f.classList.remove('on-card', 'left', 'peek', 'flying', 'arc');
        f.style.transform = `translate3d(${Math.round(h.x)}px, ${Math.round(h.y)}px, 0)`;
        f._at = h;
        f.classList.remove('hidden');
        btn.classList.add('away');
        return h;
    }
    function touchDown() {
        if (flyer) { flyer.classList.add('hidden'); flyer.classList.remove('flying', 'arc', 'left', 'peek', 'guide'); flyer._at = null; }
        btn.classList.remove('away');
        atHome = true;
        if (!reduce()) once(btn, 'landed', 700);
    }
    /**
     * Fly from one spot to another along an arc (lifted above the straight line), nose following the
     * path. One Web Animation on transform; → a promise that settles when it lands (or is cut short).
     */
    function fly(from, to, lift) {
        const f = ensureFlyer();
        const dir = to.x >= from.x ? 1 : -1;
        f.classList.add('no-move', 'arc', 'flying');
        f.classList.toggle('left', dir < 0);
        const cx = (from.x + to.x) / 2, cy = Math.min(from.y, to.y) - lift;
        const frames = [];
        for (let i = 0; i <= 14; i++) {
            const t = i / 14, u = 1 - t;
            const x = u * u * from.x + 2 * u * t * cx + t * t * to.x, y = u * u * from.y + 2 * u * t * cy + t * t * to.y;
            const dx = 2 * u * (cx - from.x) + 2 * t * (to.x - cx), dy = 2 * u * (cy - from.y) + 2 * t * (to.y - cy);
            const tilt = Math.max(-26, Math.min(26, Math.atan2(dy, Math.abs(dx) || 1) * 57.3)) * Math.sin(Math.PI * t);
            frames.push({ transform: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${(dir * tilt).toFixed(1)}deg)` });
        }
        const done = () => { f.style.transform = `translate3d(${Math.round(to.x)}px, ${Math.round(to.y)}px, 0)`; f._at = { x: to.x, y: to.y }; f.classList.remove('flying', 'arc'); anim = null; };
        if (typeof f.animate !== 'function') { done(); return Promise.resolve(); }
        anim = f.animate(frames, { duration: T(Math.max(650, Math.min(1500, Math.hypot(to.x - from.x, to.y - from.y) * 4 + 520))), easing: 'cubic-bezier(.42, .02, .3, 1)' });
        return anim.finished.then(done, () => {});
    }
    /** Cut short whatever it is doing and put it back on its perch (the guide is starting, or "Sit still"). */
    function stopAct() {
        if (!busy) return;
        busy = false;
        if (anim) { try { anim.cancel(); } catch (e) { /* an engine without it */ } anim = null; }
        if (!atHome) touchDown();
    }

    /**
     * Where it can land. Anything at the top is its to use: on top of the switch or the ⋮ and at the
     * end of the title when there is room above them, and always the bar's lower edge in the open
     * stretch between the title and the switch.
     */
    function spots() {
        const out = [], h = homeSpot();
        const top = (el, at) => { if (!el) return; const r = el.getBoundingClientRect(), y = r.top - SIZE + 6; if (r.width > 0 && y >= 2) out.push({ x: r.left + r.width * at - SIZE / 2, y }); };
        top(document.getElementById('btn-free'), 0.28); top(document.getElementById('btn-free'), 0.74); top(document.getElementById('btn-more'), 0.5);
        const t = document.querySelector('.top-bar h1');
        if (t) { const r = t.getBoundingClientRect(); if (r.width > 0 && r.top - SIZE + 12 >= 2) out.push({ x: r.right - SIZE * 0.7, y: r.top - SIZE + 12 }); }
        const bar = document.querySelector('.top-bar'), sw = document.getElementById('btn-free');
        if (bar && t && sw) {
            const b = bar.getBoundingClientRect(), from = t.getBoundingClientRect().right + 8, to = sw.getBoundingClientRect().left - 8;
            if (to - from >= SIZE) [0.2, 0.75].forEach(k => out.push({ x: from + (to - from - SIZE) * k, y: b.bottom - SIZE + 3 }));
        }
        return out.filter(p => p.x > h.x + 50 && p.x + SIZE < innerWidth - 2);
    }
    /** Two little notes drift up from its beak. */
    function notes() {
        const r = btn.getBoundingClientRect();
        ['♪', '♫'].forEach((ch, i) => {
            const n = document.createElement('span');
            n.className = 'jay-note';
            n.textContent = ch;
            n.setAttribute('aria-hidden', 'true');
            n.style.left = `${Math.round(r.right - 8 + i * 9)}px`;
            n.style.top = `${Math.round(r.top + 2)}px`;
            n.style.animationDelay = `${i * 0.28}s`;
            document.body.appendChild(n);
            setTimeout(() => n.remove(), 2000);
        });
    }
    /** Each act is short (under five seconds of movement) and uses transform and opacity only. */
    const ACTS = {
        /** Out to a landing spot in an arc, a look around, and home again. */
        async visit() {
            const list = spots();
            if (!list.length) return ACTS.lap();
            const to = list[Math.floor(Math.random() * list.length)];
            const h = takeOff(), lift = Math.max(8, Math.min(46, Math.min(h.y, to.y) - 3));
            await fly(h, to, lift);
            if (!busy) return;
            flyer.classList.add('peek');
            await wait(1500);
            if (!busy) return;
            flyer.classList.remove('peek');
            await fly(to, homeSpot(), lift);
            if (busy) touchDown();
        },
        /** No room to land anywhere: a lap along the bar and back. */
        async lap() {
            const sw = document.getElementById('btn-free');
            const h = takeOff();
            const far = { x: Math.max(h.x + 60, Math.min(innerWidth - SIZE - 50, (sw ? sw.getBoundingClientRect().left : innerWidth * 0.6) - SIZE - 8)), y: h.y };
            const lift = Math.max(6, Math.min(40, h.y - 3));
            await fly(h, far, lift);
            if (!busy) return;
            await fly(far, homeSpot(), Math.max(4, lift * 0.5));
            if (busy) touchDown();
        },
        hops() { once(btn, 'hops', 900); return wait(900); },
        preen() { once(btn, 'preen', 1700); return wait(1700); },
        look() { once(btn, 'look', 1500); return wait(1500); },
        sing() { once(btn, 'sing', 1500); notes(); return wait(1500); },
        shiver() { once(btn, 'shiver', 1100); return wait(1100); }
    };
    /** Is this a good moment? Not when it is asked to sit still, asleep, away, mid-guide, or when the visitor is busy with a sheet, a menu or typing. */
    const free = () => !!btn && atHome && !busy && !reduce() && !still() && !btn.classList.contains('asleep') && document.visibilityState === 'visible'
        && !(window.SkateTour && SkateTour.running)
        && !(window.SkateUI && ((SkateUI.Modal && SkateUI.Modal.any && SkateUI.Modal.any()) || (SkateUI.Popover && SkateUI.Popover.isOpen && SkateUI.Popover.isOpen())))
        && !(bubble && !bubble.classList.contains('hidden'))
        && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
    /** Do one thing now: the one named, or its own pick. → a promise of the act's name, or false when it is not the moment. */
    async function act(name) {
        mood();
        if (!free()) return false;
        const w = window.SkateWeather && SkateWeather.current, feels = w ? Number(w.feels != null ? w.feels : w.temp) : NaN;
        const pool = ['visit', 'visit', 'lap', 'hops', 'preen', 'look', 'sing', ...(Number.isFinite(feels) && feels <= -10 ? ['shiver', 'shiver'] : [])].filter(a => a !== lastAct);
        const pick = Object.prototype.hasOwnProperty.call(ACTS, name) ? name : pool[Math.floor(Math.random() * pool.length)];
        lastAct = pick;
        busy = true;
        try { await ACTS[pick](); } finally { if (busy) { busy = false; if (!atHome) touchDown(); } }
        return pick;
    }
    function schedule(soon) {
        clearTimeout(actTimer);
        if (reduce() || still()) return;
        actTimer = setTimeout(() => { act().then(() => schedule(false), () => schedule(false)); }, soon ? 9000 + Math.random() * 6000 : 40000 + Math.random() * 50000);
    }
    /** A session was saved: a happy hop and two notes. */
    function cheer() { mood(); if (free()) { once(btn, 'hop', 450); notes(); } }

    /** The guide's card moved: fly to its top edge and stand there. */
    function guide(card) {
        if (!btn || !card || !card.isConnected || reduce()) return;
        stopAct();
        clearTimeout(actTimer);
        clearTimeout(homeTimer);
        hush();
        const f = ensureFlyer();
        const r = card.getBoundingClientRect();
        const to = { x: Math.min(innerWidth - SIZE - 6, r.right - SIZE - 14), y: Math.max(4, r.top - SIZE + 5) };
        if (f._at && Math.abs(f._at.x - to.x) < 2 && Math.abs(f._at.y - to.y) < 2 && !atHome) return;   // already standing there
        if (atHome) { takeOff(); void f.offsetWidth; }
        f.classList.remove('no-move', 'arc');
        f.classList.add('on-card', 'guide');
        place(to.x, to.y, true);
    }
    /** The guide is over (finished or skipped): fly back to the perch. */
    function home() {
        if (!btn || atHome || !flyer || busy) return;
        atHome = true;
        const h = homeSpot();
        flyer.classList.remove('on-card', 'no-move');
        place(h.x, h.y, true);
        clearTimeout(homeTimer);
        homeTimer = setTimeout(() => { touchDown(); schedule(false); }, 920);
    }

    function init() {
        btn = document.getElementById('jay');
        if (!btn || btn.dataset.ready) return;
        btn.dataset.ready = '1';
        btn.innerHTML = SVG;
        bubble = document.createElement('div');
        bubble.className = 'jay-say hidden';
        bubble.setAttribute('role', 'status');
        bubble.setAttribute('aria-live', 'polite');
        bubble.addEventListener('click', hush);
        document.body.appendChild(bubble);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            hush();
            if (btn.classList.contains('asleep')) { awakeUntil = Date.now() + 90000; mood(); }      // a tap wakes it for a while
            if (!reduce() && atHome) once(btn, 'hop', 450);
            if (window.SkateUI && SkateUI.Popover) SkateUI.Popover.open(btn, menu(), 'The blue jay');
        });
        window.addEventListener('scroll', hush, { capture: true, passive: true });
        window.addEventListener('resize', () => { hush(); stopAct(); if (!atHome && flyer) home(); });
        document.addEventListener('visibilitychange', () => { mood(); if (document.visibilityState !== 'visible') stopAct(); });
        setInterval(mood, 60000);
        mood();
        schedule(true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    return {
        guide, home, say, weatherLine, act, cheer, mood, SVG,
        get atHome() { return atHome; }, get still() { return still(); },
        set tempo(v) { tempo = Number(v) > 0 ? Number(v) : 1; }          // tests run the acts faster
    };
})();
