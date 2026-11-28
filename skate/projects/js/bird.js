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
 *  - v3.22: redrawn from the bird's field marks (dull blue back, brighter barred wings and tail, the
 *    white wing bar and tail corners, the black necklace round a white throat, a stout black bill),
 *    and lifelike between acts: see "lifelike" below.
 *
 * Nothing here reads or stores anything about the visitor.
 */
window.SkateBird = (() => {
    const SVG = `
<svg class="jay-svg" viewBox="0 0 128 128" aria-hidden="true" focusable="false">
  <g class="jay-twig">
    <path class="jay-twig-main" d="M24 112.6C46 108.4 78 109 109 113.8"/>
    <path class="jay-twig-side" d="M89 110.8c4.6-3.4 8.400-7 12.200-11.400"/>
    <path class="jay-twig-shade" d="M27 114.4C48 110.700 78 111.200 106 115.400"/>
    <circle class="jay-twig-bud" cx="101.600" cy="98.800" r="1.9"/>
  </g>
  <g class="jay-bird">
    <g class="jay-tail">
      <path class="jay-tail-deep" d="M46.1 85.4L19.4 113.3Q16.6 115.5 14.7 113.6Q12.7 111.8 14.8 108.9L41.4 80.9Z"/>
      <path class="jay-white" d="M22.2 110.4L19.4 113.3Q16.6 115.5 14.7 113.6Q12.7 111.8 14.8 108.9L17.5 106Z"/>
      <path class="jay-bars" d="M38.7 92.2L34.4 89.3M35 96.1L30.6 93.2M31.2 100L26.9 97.1M27.5 103.9L23.2 101M23.8 107.8L19.5 104.9"/>
      <path class="jay-tail-deep" d="M52.4 91.4L23.9 121.3Q21.3 123.4 19.4 121.6Q17.6 119.9 19.6 117.2L48.1 87.3Z"/>
      <path class="jay-white" d="M26.1 119L23.9 121.3Q21.3 123.4 19.4 121.6Q17.6 119.9 19.6 117.2L21.8 114.9Z"/>
      <path class="jay-bars" d="M45.1 98.3L41 95.6M41.4 102.2L37.3 99.5M37.6 106.1L33.5 103.4M33.9 110L29.8 107.3M30.2 113.9L26.1 111.2"/>
      <path class="jay-tail-top" d="M49.5 88.7L18.7 121Q15.5 123.4 13.4 121.4Q11.2 119.3 13.5 116L44.3 83.7Z"/>
      <path class="jay-bars" d="M42.1 95.4L37.3 92.1M38.4 99.3L33.6 96M34.6 103.2L29.9 99.9M30.9 107.1L26.1 103.8M27.2 111L22.4 107.7M23.5 114.9L18.7 111.6M19.7 118.9L14.9 115.5"/>
    </g>
    <g class="jay-legs">
      <path class="jay-leg" d="M72 100.500 71.200 110.600M82.600 99.400l1 11"/>
      <path class="jay-toe" d="M67.400 112.300c1.700-2.600 5.900-2.800 7.800-.2M79.600 112.100c1.800-2.600 6-2.600 7.900.1"/>
    </g>
    <path class="jay-back" d="M80 52C66 51 48 60 41 77c-2.500 7-.5 15 6 20 8 6 23 7.500 35 2.500C95 94 103.500 80 103 65c-.2-6-3-10.500-7-13z"/>
    <g class="jay-chest">
      <path class="jay-pale jay-edge" d="M103 65c.5 15-8 29-21 34.500-12 5-27 3.500-35-2.500-1.600-1.400-3-3-4-4.800C54 96 69 93.500 80 84c8-7 12.500-16 13.500-25.500 3-2 7 .500 9.500 6.500z"/>
      <path class="jay-flank" d="M43 92.200C54 96 69 93.500 80 84c-4 8-14 14-25 15.500-4.500-.9-8.600-3.300-12-7.300z"/>
      <path class="jay-wash" d="M93.500 58.500c3-2 7 .5 9.500 6.500.2 6-1 12-3.400 17.400-3.400-6.200-5.800-14.600-6.100-23.900z"/>
    </g>
    <path class="jay-back-shine" d="M76 54.500c-10 1-20.500 7-27 16.500"/>
    <g class="jay-wing">
      <path class="jay-wing-main" d="M88 59c-8-5.500-24-3.500-35 7-7 7-11.500 17-12.500 27 9.500 1.500 22.500-3 32.500-11.500 8-7 14.500-14.500 17-19.500 0-1.400-.8-2.500-2-3z"/>
      <path class="jay-wing-tip" d="M40.500 93c1-7 3.500-13.500 7.500-19 1.500 6 1 13-1.200 19.400-2.200.2-4.300 0-6.300-.4z"/>
      <path class="jay-bars" d="M72.7 69.4Q74 74.3 77.8 79.3M68.9 71.9Q70.1 76.5 73.7 81.2M65.1 74.3Q66.2 78.7 69.6 83.1M61.3 76.8Q62.3 80.9 65.5 85.1M57.5 79.3Q58.4 83.1 61.4 87M53.8 81.7Q54.4 85.3 57.3 88.9M50 84.2Q50.5 87.6 53.2 90.8"/>
      <path class="jay-scap" d="M88 59c-8-5.500-19.500-4.400-29 1.500 5.500 4 14 6.100 23 4.500 3.600-1 6.400-3.200 6-6z"/>
      <path class="jay-bars jay-bars-fine" d="M64 62.6l-1.4 6M69.2 62.6l-1.4 6M74.4 62.7l-1.4 6M79.6 62.8l-1.4 6"/>
      <path class="jay-bar-white" d="M58.800 71.600c8.400-.4 17-1.800 24.400-4.400"/>
      <path class="jay-tips-white" d="M49.800 91.600l4-1.400M57.400 88.900l3.800-1.800M64.600 85.300l3.500-2.200"/>
      <path class="jay-wing-shine" d="M86 60.800c-7-3.600-17-3-25 1.600"/>
    </g>
    <g class="jay-head">
      <path class="jay-white jay-edge" d="M77 46c-.5-11 7-18.500 16.500-18.500 9 0 15.500 6.500 15.500 15.500 0 9.500-6.500 16.500-15.500 17-8.500.3-16-5.500-16.500-14z"/>
      <path class="jay-collar" d="M77.200 43.500c-1.600 10 3.600 19.300 13.800 22.500 6.400 2 12.600 0 15.600-4.600-3.600 1.800-8.600 2.200-13.600.6-8.400-2.700-12.400-9.400-12-16.600-1.100-1.200-2.400-1.900-3.800-1.900z"/>
      <path class="jay-crown" d="M108.600 39c-2.100-7.500-8.100-12-15.600-12-4.500 0-8.500 1.600-11.500 4.400-2.500 2.600-4.100 6.200-4.500 10.200 0 2 .3 3.800.8 5.400C84 40.500 96 37 108.600 39z"/>
      <g class="jay-crest">
        <path class="jay-crown-top" d="M99 28.200C90 22.500 77 15.800 62 13.500c4.500 3.300 8 6.900 10.400 10.900-3.600-.8-7.600-.6-11.900.8 6 3.200 11 8.200 15.100 15.200 3.600-6.200 11.900-10.800 23.400-12.200z"/>
        <path class="jay-crest-line" d="M69 17.600c7 3 14 6.800 20 11M67.600 26.600c4 2.200 7.600 5.200 10.400 8.800"/>
      </g>
      <path class="jay-eyeline" d="M106.800 43.600c-3.200-1.400-6.200-2-8.800-1.800M95 42.400c-4.500.6-9.500 2-13.600 3.800"/>
      <g class="jay-eye"><circle class="jay-ink" cx="97.600" cy="41.400" r="3"/><circle class="jay-glint" cx="98.600" cy="40.300" r=".9"/></g>
      <path class="jay-bill" d="M107.600 39.600c4.900.2 10.800 2.800 15 6.600-4.800.2-10 .3-15 0-.5-2.200-.5-4.400 0-6.600z"/>
      <path class="jay-bill-low" d="M107.600 46.200c5 .3 10.200.2 15 0-4 3-9.400 4.200-14.200 3.400-.5-1.100-.8-2.200-.8-3.400z"/>
      <path class="jay-bill-shine" d="M109.600 40.600c4.400.8 8.400 2.800 11.200 4.800"/>
      <path class="jay-tuft" d="M106 38.400c2-.8 4.400-.2 5.600 1.400-1.800.2-3.600.4-5.200 1z"/>
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
        'The Map view shows what is close to you.',
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
        tick();
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
    const SIZE = 40;
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

    /* ---- lifelike (v3.22) ----
     * A real bird is never frozen and never on a beat: its head darts to a new angle and holds, it
     * blinks, the tail flicks, the crest lifts when something catches its eye, it shifts its feet.
     * So a timer with irregular gaps picks one small move at a time, and each move only sets a
     * number the stylesheet turns into one short transition on one group of the drawing. It looks
     * toward where you tap (and follows a mouse), and glances down when the page scrolls.
     */
    const life = { head: 0, timer: 0, lookUntil: 0, alertUntil: 0, lastScroll: 0, lastMove: 0 };
    const rnd = (a, b) => a + Math.random() * (b - a);
    const any = (list) => list[Math.floor(Math.random() * list.length)];
    const setVar = (k, v) => { if (btn) btn.style.setProperty(k, v); if (flyer) flyer.style.setProperty(k, v); };
    const alive = () => !!btn && !reduce() && !still() && !btn.classList.contains('asleep') && document.visibilityState === 'visible';
    function headTo(deg) { life.head = Math.max(-20, Math.min(18, deg)); setVar('--jay-head', `${life.head.toFixed(1)}deg`); }
    function blink(n) { setVar('--jay-lid', '.1'); setTimeout(() => { setVar('--jay-lid', '1'); if (n > 1) setTimeout(() => blink(n - 1), 140); }, 90); }
    function flick() { setVar('--jay-tail', `${rnd(4, 9).toFixed(1)}deg`); setTimeout(() => setVar('--jay-tail', '0deg'), 120); }
    function crestTo(deg) { setVar('--jay-crest', `${deg}deg`); }
    function shuffle() { setVar('--jay-step', `${Math.random() < 0.5 ? -3 : 3}px`); setVar('--jay-bob', '-3.5px'); setTimeout(() => setVar('--jay-bob', '0px'), 110); setTimeout(() => setVar('--jay-step', '0px'), rnd(900, 2600)); }
    function puff() { setVar('--jay-puff', '1.05'); setTimeout(() => setVar('--jay-puff', '1'), 520); }
    function calm() { ['--jay-head', '--jay-tail', '--jay-crest', '--jay-lid', '--jay-step', '--jay-bob', '--jay-puff'].forEach(k => { if (btn) btn.style.removeProperty(k); if (flyer) flyer.style.removeProperty(k); }); life.head = 0; }
    function tick() {
        clearTimeout(life.timer);
        if (!alive()) { calm(); life.timer = setTimeout(tick, 3000); return; }
        const now = Date.now(), alert = now < life.alertUntil, r = Math.random();
        if (!busy || !atHome) {
            if (now > life.lookUntil && r < 0.40) headTo(any([-15, -10, -6, -3, 0, 0, 3, 7, 11]) + rnd(-1.5, 1.5));    // a snap to a new angle, then it holds
            else if (r < 0.58) blink(Math.random() < 0.22 ? 2 : 1);
            else if (r < 0.70) flick();
            else if (r < 0.78) crestTo(alert ? -15 : any([0, 0, -7, 5]));
            else if (r < 0.84 && atHome && !busy) shuffle();
            else if (r < 0.88) puff();
        }
        life.timer = setTimeout(tick, alert ? rnd(240, 800) : rnd(420, 2300));
    }
    /** Something happened over there: it looks that way, crest up, for a moment. */
    function attend(x, y, keen) {
        if (!alive() || !atHome || busy) return;
        const r = btn.getBoundingClientRect();
        const ang = Math.atan2(y - (r.top + r.height * 0.33), Math.max(24, x - (r.left + r.width * 0.75))) * 57.3;   // 0 = straight ahead, + = down
        headTo(ang * 0.55);
        life.lookUntil = Date.now() + (keen ? 1900 : 1100);
        if (keen) { crestTo(-14); life.alertUntil = Date.now() + 3200; setTimeout(() => { if (Date.now() >= life.alertUntil - 60) crestTo(0); }, 3300); }
    }
    function senses() {
        document.addEventListener('pointerdown', (e) => { if (!e.target.closest || !e.target.closest('#jay')) attend(e.clientX, e.clientY, true); }, { capture: true, passive: true });
        document.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse') return; const now = Date.now(); if (now - life.lastMove < 160) return; life.lastMove = now; attend(e.clientX, e.clientY, false); }, { passive: true });
        document.addEventListener('scroll', () => { const now = Date.now(); if (now - life.lastScroll < 3500 || !alive() || !atHome || busy) return; life.lastScroll = now; headTo(12); flick(); life.lookUntil = now + 900; }, { capture: true, passive: true });
    }

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
        senses();
        life.timer = setTimeout(tick, 900);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    return {
        guide, home, say, weatherLine, act, cheer, mood, SVG,
        look: attend, get head() { return life.head; },
        get atHome() { return atHome; }, get still() { return still(); },
        set tempo(v) { tempo = Number(v) > 0 ? Number(v) : 1; }          // tests run the acts faster
    };
})();
