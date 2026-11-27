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

    function menu() {
        const next = (list, key) => list[turn[key]++ % list.length];
        return [
            { label: 'A tip', onClick: () => say(next(TIPS, 'tip')) },
            { label: 'How cold is it?', onClick: () => say(weatherLine()) },
            { label: 'A blue jay fact', onClick: () => say(next(FACTS, 'fact')) },
            { label: 'Feed the bird', onClick: () => { if (!reduce()) once(btn, 'pecking', 1300); say(FED[Math.min(turn.fed++, FED.length - 1)]); } }
        ];
    }

    /* ---- flying (the guide) ---- */
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

    /** The guide's card moved: fly to its top edge and stand there. */
    function guide(card) {
        if (!btn || !card || !card.isConnected || reduce()) return;
        clearTimeout(homeTimer);
        hush();
        const f = ensureFlyer();
        const r = card.getBoundingClientRect();
        const to = { x: Math.min(innerWidth - SIZE - 6, r.right - SIZE - 14), y: Math.max(4, r.top - SIZE + 5) };
        if (f._at && Math.abs(f._at.x - to.x) < 2 && Math.abs(f._at.y - to.y) < 2 && !atHome) return;   // already standing there
        if (atHome) {                                            // take off from the perch
            atHome = false;
            const h = homeSpot();
            f.classList.add('no-move');
            place(h.x, h.y, false);
            f.classList.remove('hidden');
            btn.classList.add('away');
            void f.offsetWidth;
            f.classList.remove('no-move');
        }
        f.classList.add('on-card');
        place(to.x, to.y, true);
    }
    /** The guide is over (finished or skipped): fly back to the perch. */
    function home() {
        if (!btn || atHome || !flyer) return;
        atHome = true;
        const h = homeSpot();
        flyer.classList.remove('on-card');
        place(h.x, h.y, true);
        clearTimeout(homeTimer);
        homeTimer = setTimeout(() => { flyer.classList.add('hidden'); flyer._at = null; btn.classList.remove('away'); if (!reduce()) once(btn, 'landed', 700); }, 920);
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
            if (!reduce()) once(btn, 'hop', 450);
            if (window.SkateUI && SkateUI.Popover) SkateUI.Popover.open(btn, menu(), 'The blue jay');
        });
        window.addEventListener('scroll', hush, { capture: true, passive: true });
        window.addEventListener('resize', () => { hush(); if (!atHome && flyer) home(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    return { guide, home, say, weatherLine, SVG, get atHome() { return atHome; } };
})();
