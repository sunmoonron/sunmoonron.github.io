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
 *  - v3.24: slimmer (it had come out a ball) and its crest lies back in one piece (it was two spikes:
 *    "punk hair"). The crest now rises when something catches its eye; the sign was the wrong way
 *    round. And it can point something out when the app asks: see point().
 *
 *  - v3.25: on its way to what it points out it swoops down over the page and up again before it
 *    lands, and only then says its line.
 *
 * Nothing here reads or stores anything about the visitor.
 */
window.SkateBird = (() => {
    const SVG = `
<svg class="jay-svg" viewBox="0 0 128 128" aria-hidden="true" focusable="false">
  <g class="jay-twig">
    <path class="jay-twig-main" d="M24 109.2C46 105 78 105.6 109 110.4"/>
    <path class="jay-twig-side" d="M89 107.4c4.6-3.4 8.4-7 12.2-11.4"/>
    <path class="jay-twig-shade" d="M27 111C48 107.3 78 107.8 106 112"/>
    <circle class="jay-twig-bud" cx="101.6" cy="95.4" r="1.9"/>
  </g>
  <g class="jay-bird">
    <g class="jay-tail">
      <path class="jay-tail-deep" d="M49.3 85.6L22.8 113.3Q20.4 115.2 18.7 113.6Q17 112 18.8 109.4L45.2 81.7Z"/>
      <path class="jay-white" d="M25.5 110.5L22.8 113.3Q20.4 115.2 18.7 113.6Q17 112 18.8 109.4L21.5 106.6Z"/>
      <path class="jay-bars" d="M42 92.4L38.1 90M38.4 96.2L34.5 93.7M34.8 99.9L30.9 97.5M31.2 103.7L27.3 101.3M27.6 107.5L23.7 105"/>
      <path class="jay-tail-deep" d="M54.6 90.7L26.3 120.4Q24 122.2 22.4 120.7Q20.9 119.2 22.5 116.8L50.9 87.1Z"/>
      <path class="jay-white" d="M28.5 118.1L26.3 120.4Q24 122.2 22.4 120.7Q20.9 119.2 22.5 116.8L24.7 114.5Z"/>
      <path class="jay-bars" d="M47.4 97.6L43.7 95.3M43.8 101.3L40.1 99.1M40.2 105.1L36.5 102.9M36.6 108.8L33 106.6M33 112.6L29.4 110.4"/>
      <path class="jay-tail-top" d="M52.2 88.4L21.6 120.5Q18.8 122.7 16.9 120.9Q14.9 119 17 116.1L47.6 84Z"/>
      <path class="jay-bars" d="M44.9 95.2L40.6 92.3M41.3 99L37 96.1M37.7 102.7L33.4 99.8M34.1 106.5L29.8 103.6M30.5 110.2L26.2 107.4M26.9 114L22.6 111.1M23.3 117.8L19 114.9"/>
    </g>
    <g class="jay-legs">
      <path class="jay-leg" d="M68.4 96 67.4 107M78.2 94.5l.6 12.5"/>
      <path class="jay-toe" d="M63.6 108.8c1.7-2.6 5.9-2.8 7.8-.2M74.8 108.7c1.8-2.6 6-2.6 7.9.1"/>
    </g>
    <path class="jay-back" d="M80 54C70 55 57 66 49 82c-2 5-1 10 4 13 9 5 24 4 33-3 8-6 14-17 13-28-.5-5-3.5-9-8-11z"/>
    <g class="jay-chest">
      <path class="jay-pale jay-edge" d="M99 64c1 11-5 22-13 28-9 7-24 8-33 3-1.8-1.2-3.2-2.7-4.2-4.4C58 92 71 88 79 80c7-6.5 11-14.5 11.5-23 3-1.5 7 1 8.5 7z"/>
      <path class="jay-flank" d="M48.8 90.6C58 92 71 88 79 80c-3.5 7.5-12.5 13.5-23 15.6-3-1-5.4-2.7-7.2-5z"/>
      <path class="jay-wash" d="M90.5 57c3-1.5 7 1 8.5 7 .3 5.5-.8 11-2.8 16-3-6-5.3-14-5.7-23z"/>
    </g>
    <path class="jay-back-shine" d="M77 56.5c-9 2.5-17.5 9.5-23.5 19"/>
    <g class="jay-wing">
      <path class="jay-wing-main" d="M87 61c-7-4-19-2-27 6-6 6-10 14.5-11.5 23 8.5.5 19.5-4 27.5-11 6-5.5 11-11 13-15.5 0-1.2-.8-2.1-2-2.5z"/>
      <path class="jay-wing-tip" d="M48.5 90c.8-6.5 3-12.5 6.5-17.5 1.6 5.5 1.4 12-.6 17.9-2 .2-4 0-5.9-.4z"/>
      <path class="jay-bars" d="M74.5 69Q75.7 72.9 79 76.8M71.1 71.5Q72.1 75.2 75.3 78.8M67.7 74Q68.6 77.4 71.5 80.8M64.3 76.4Q65.1 79.7 67.8 82.7M60.9 78.9Q61.5 81.9 64.1 84.7M57.5 81.4Q58 84.2 60.4 86.6"/>
      <path class="jay-scap" d="M87 61c-7-4-17.5-2.7-25 3.5 5 3.1 12.5 4.3 19.5 2.5 3.1-1 5.5-3 5.5-6z"/>
      <path class="jay-bars jay-bars-fine" d="M66.6 64.9l-1.2 5M71.2 64.6l-1.2 5M75.8 64.3l-1.2 5M80.4 64l-1.2 5"/>
      <path class="jay-bar-white" d="M62.4 73.3c7.2-.6 14.2-2.2 20.2-4.8"/>
      <path class="jay-tips-white" d="M54.6 88.6l3.6-1M61.4 86.5l3.4-1.6M67.8 83.3l3-2"/>
      <path class="jay-wing-shine" d="M85.4 62.6c-6-3-14.6-2.4-21.6 1.8"/>
    </g>
    <g class="jay-head">
      <path class="jay-white jay-edge" d="M79.6 46a13.4 13.4 0 1 1 26.8 0a13.4 13.4 0 1 1 -26.8 0Z"/>
      <path class="jay-collar" d="M78.3 42.1A14.9 14.9 0 0 0 103.2 57.1L103.1 54.9A13.3 13.3 0 0 1 80.9 41.6Z"/>
      <path class="jay-crown" d="M106.2 43.4C104.8 36.6 99.6 32.6 93 32.6c-7.4 0-13.4 5.8-13.4 13.2C83.6 42.4 94.6 39.6 106.2 43.4z"/>
      <g class="jay-crest">
        <path class="jay-crown-top" d="M101.5 35.2C94 30 85 27.3 76 27.2c-1.7 0-2.2 1.1-1.3 2.2 2.8 2.9 4.9 6.4 6 10.3C84.2 37 92 35.2 101.5 35.2z"/>
        <path class="jay-crest-line" d="M79.4 29.4c5.6.5 11 2.1 15.8 4.7M81.6 33.6c2.8.5 5.4 1.4 7.8 2.7"/>
      </g>
      <path class="jay-eyeline" d="M105.4 45.6c-2.2-.8-4-1.1-5.4-1M94.4 45c-4.4.5-9 1.8-12.8 3.6"/>
      <g class="jay-eye"><circle class="jay-ink" cx="97.2" cy="44.4" r="2.7"/><circle class="jay-glint" cx="98.1" cy="43.4" r=".8"/></g>
      <path class="jay-bill" d="M105.4 42.4c4.8.4 10.2 2.2 14 4.9-4.6.3-9.4.4-14.2.2-.5-1.7-.4-3.5.2-5.1z"/>
      <path class="jay-bill-low" d="M105.2 47.5c4.8.2 9.6.1 14.2-.2-3.7 2.4-8.3 3.3-13.2 2.7-.6-.8-.9-1.6-1-2.5z"/>
      <path class="jay-bill-shine" d="M107 43.5c3.9.7 7.3 2 10.1 3.4"/>
      <path class="jay-tuft" d="M104.2 41.6c1.8-.6 3.8 0 4.8 1.3-1.6.2-3 .5-4.4 1z"/>
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
        'On the map, type your address in the box at the top to see what is close to you.',
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
        hush();
        bubble.textContent = text;
        const r = btn.getBoundingClientRect();
        bubble.style.top = `${Math.round(r.bottom + 8)}px`;
        bubble.style.left = `${Math.max(8, Math.round(r.left))}px`;
        bubble.classList.remove('hidden');
        hideTimer = setTimeout(hush, Math.min(12000, 4000 + text.length * 55));
    }
    let pointing = null;     // v3.24: what it is pointing out right now ({ end() }), if anything
    function hush() {
        clearTimeout(hideTimer);
        if (bubble) { bubble.classList.add('hidden'); bubble.classList.remove('beside'); bubble.style.maxWidth = ''; }
        if (pointing) { const p = pointing; pointing = null; p.end(); }      // the line is gone: it stops pointing and goes home
    }

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
    function fly(from, to, lift, o = {}) {
        const f = ensureFlyer();
        const dir = to.x >= from.x ? 1 : -1;
        f.classList.add('no-move', 'arc', 'flying');
        f.classList.toggle('left', dir < 0);
        // the bend: by default lifted above the straight line; a swoop names its own (v3.25)
        const cx = o.cx != null ? o.cx : (from.x + to.x) / 2, cy = o.cy != null ? o.cy : Math.min(from.y, to.y) - lift;
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
        anim = f.animate(frames, { duration: T(o.ms || Math.max(650, Math.min(1500, Math.hypot(to.x - from.x, to.y - from.y) * 4 + 520))), easing: 'cubic-bezier(.42, .02, .3, 1)' });
        return anim.finished.then(done, () => {});
    }
    /** Stop a flight where it is: the flying copy keeps its place and can be sent somewhere else from there. */
    function halt() {
        if (!anim || !flyer) return;
        const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(flyer).transform || '');
        try { anim.cancel(); } catch (e) { /* an engine without it */ }
        anim = null;
        flyer.classList.remove('arc', 'flying');
        if (m) {
            const v = m[1].split(',').map(Number);
            flyer.style.transform = `translate3d(${v[4].toFixed(1)}px, ${v[5].toFixed(1)}px, 0)`;
            flyer._at = { x: v[4], y: v[5] };
            void flyer.offsetWidth;        // it is there now: the next move starts from there
        }
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
            else if (r < 0.78) crestTo(alert ? 20 : any([0, 0, 8, -5]));        // up when alert; otherwise it lifts or settles a little
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
        if (keen) { crestTo(22); life.alertUntil = Date.now() + 3200; setTimeout(() => { if (Date.now() >= life.alertUntil - 60) crestTo(0); }, 3300); }
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

    /* ---- pointing something out (v3.24) ----
     * Asked by the app, once, for a control that is easy to miss. It flies to the top edge of that
     * control (v3.25: by way of a swoop down the page and back up, `opts.via` naming the low point) and
     * only then says one line beside itself, above the control (never over it); the control gets a
     * soft ring. At the first tap or key, or after a few seconds, the line goes and it flies home.
     * `opts.onShown` is called when the line is actually up (a tap mid-flight means it never was).
     * With "Sit still" or reduce motion it stays on its perch and only the line and the ring show.
     * → true when it did.
     */
    function point(el, text, opts = {}) {
        if (!btn || !bubble || !el || !el.isConnected || !text) return false;
        if ((window.SkateTour && SkateTour.running) || (window.SkateUI && SkateUI.Modal && SkateUI.Modal.any && SkateUI.Modal.any())) return false;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        hush();
        stopAct();
        clearTimeout(actTimer);
        clearTimeout(homeTimer);
        awakeUntil = Date.now() + 90000; mood();                                        // asked for at night: it wakes for this
        const moves = !reduce() && !still();
        const perch = { x: Math.max(4, Math.min(innerWidth - SIZE - 4, r.left + 2)), y: Math.max(2, r.top - SIZE + 8) };
        const me = { ended: false };
        let endTimer = 0;
        el.classList.add('jay-points');
        const show = () => {
            if (me.ended) return;
            bubble.textContent = text;
            bubble.classList.add('beside');
            const left = Math.round(perch.x + SIZE + 2);
            bubble.style.maxWidth = `${Math.max(150, Math.min(300, innerWidth - left - 8))}px`;
            bubble.style.left = `${left}px`;
            bubble.classList.remove('hidden');
            bubble.style.top = `${Math.max(4, Math.round(r.top - 6 - bubble.offsetHeight))}px`;   // above the control, its lower corner at the beak
            endTimer = setTimeout(hush, opts.ms || 9000);
            if (typeof opts.onShown === 'function') { try { opts.onShown(); } catch (e) { /* the caller's own business */ } }
        };
        /* v3.25: the way there is a swoop to be seen (people learn by eye): out along the top, down over the page
         * ("south"), up again ("north") and in along the control's top edge to land on its near end. Two arcs:
         * the first ends heading straight down, the second starts straight up, so the turn at the bottom is clean. */
        const flyIn = async () => {
            const f = ensureFlyer();
            const from = atHome ? takeOff() : { ...(f._at || homeSpot()) };
            f.classList.remove('on-card', 'guide', 'peek');
            void f.offsetWidth;
            const wish = opts.via && Number.isFinite(opts.via.x) && Number.isFinite(opts.via.y)
                ? { x: opts.via.x - SIZE / 2, y: opts.via.y - SIZE / 2 }
                : { x: r.left + Math.min(r.width * 0.62, 240), y: r.bottom + Math.min(innerHeight * 0.34, 300) };
            const via = { x: Math.max(perch.x + 90, Math.min(innerWidth - SIZE - 16, wish.x)), y: Math.max(r.bottom + 50, Math.min(innerHeight - SIZE - 24, wish.y)) };
            const leg = (a, b) => Math.max(820, Math.min(1350, Math.hypot(b.x - a.x, b.y - a.y) * 2.6 + 380));
            await fly(from, via, 0, { cx: Math.min(innerWidth - SIZE - 6, via.x + 34), cy: Math.max(2, from.y + 6), ms: leg(from, via) });
            if (me.ended) return;
            await fly(via, perch, 0, { cx: perch.x + (via.x - perch.x) * 0.5, cy: Math.max(2, perch.y - 8), ms: leg(via, perch) });
            if (me.ended) return;
            f.classList.remove('left');                                                  // it turns to face the line it is about to say
            f.classList.add('on-card', 'peek');
            await wait(420);
            show();
        };
        const onInput = () => hush();
        document.addEventListener('pointerdown', onInput, { capture: true, passive: true });
        document.addEventListener('keydown', onInput, { capture: true });
        pointing = {
            end() {
                me.ended = true;
                clearTimeout(endTimer);
                document.removeEventListener('pointerdown', onInput, { capture: true });
                document.removeEventListener('keydown', onInput, { capture: true });
                el.classList.remove('jay-points');
                halt();                                                                  // cut short mid-swoop: it turns for home from where it is
                if (!atHome && flyer && !busy) home();
            }
        };
        if (moves) flyIn(); else show();
        return true;
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
        guide, home, say, point, hush, weatherLine, act, cheer, mood, SVG,
        get pointing() { return !!pointing; },
        look: attend, get head() { return life.head; },
        get atHome() { return atHome; }, get still() { return still(); },
        set tempo(v) { tempo = Number(v) > 0 ? Number(v) : 1; }          // tests run the acts faster
    };
})();
