# The blue jay's drawing (skate/projects/js/bird.js holds the result, between <svg class="jay-svg"> and </svg>).
# Not part of the site or of the test suite: a tool for the next time the bird needs redrawing.
#
#   python3 skate/tests/tools/jay_svg.py /tmp/jay.svg.txt          # write the drawing
#   node skate/tests/tools/render-jay.js /tmp/jay.svg.txt /tmp/jay.png   # look at it, large and at 40px, light and dark
#   node skate/tests/tools/render-jay.js bird /tmp/jay.png               # the same for what bird.js holds now
#
# Then paste the SVG into bird.js and, if a part's pivot moved, update the transform-origin lines beside
# ".jay-svg .jay-head" in style-v3.css. Each part is drawn from the bird's field marks; the feather bars are
# computed. v3.24: slimmer (it was a ball) and the crest lies back in one piece (it was two spikes).
import math, sys
f = lambda v: ('%.1f' % v).rstrip('0').rstrip('.')
def P(*pts): return ' '.join(f(v) for v in pts)

# ---- tail: three feathers along one axis, the middle one on top; black bars; the outer ones white-tipped ----
B, T = (48.0, 88.5), (17.0, 121.0)
ax = (T[0] - B[0], T[1] - B[1]); L = math.hypot(*ax); u = (ax[0] / L, ax[1] / L); p = (-u[1], u[0])   # p points up-left of the axis
def at(d, o): return (B[0] + u[0] * d + p[0] * o, B[1] + u[1] * d + p[1] * o)
def feather(o, w, length, cls, tip=None, bars=True):
    a, b = at(-3, o - w / 2), at(-3, o + w / 2)
    c, d = at(length - w * .55, o + w / 2), at(length - w * .55, o - w / 2)
    e = at(length, o)
    out = [f'<path class="{cls}" d="M{P(*a)}L{P(*d)}Q{P(*at(length, o - w * .42))} {P(*e)}Q{P(*at(length, o + w * .42))} {P(*c)}L{P(*b)}Z"/>']
    if tip:
        t0 = length - tip
        a2, b2 = at(t0, o - w / 2), at(t0, o + w / 2)
        out.append(f'<path class="jay-white" d="M{P(*a2)}L{P(*d)}Q{P(*at(length, o - w * .42))} {P(*e)}Q{P(*at(length, o + w * .42))} {P(*c)}L{P(*b2)}Z"/>')
    if bars:
        end = length - (tip or 3) - 2.5
        d0 = 7.0
        segs = []
        while d0 < end:
            s, e2 = at(d0, o - w * .40), at(d0 + .9, o + w * .40)
            segs.append(f'M{P(*s)}L{P(*e2)}')
            d0 += 5.2
        out.append(f'<path class="jay-bars" d="{"".join(segs)}"/>')
    return '\n      '.join(out)
tail = '\n      '.join([
    feather(3.9, 5.6, L - 6.5, 'jay-tail-deep', tip=7.0),
    feather(-3.7, 5.2, L - 4.0, 'jay-tail-deep', tip=6.0),
    feather(0.2, 6.4, L, 'jay-tail-top', tip=None),
])

# ---- wing: black bars across the secondaries, lengths chosen to stay inside the outline ----
S0 = (80.0, 70.2); tipW = (51.0, 88.6)
wa = (tipW[0] - S0[0], tipW[1] - S0[1]); WL = math.hypot(*wa); wu = (wa[0] / WL, wa[1] / WL); wp = (-wu[1], wu[0])
def wat(d, o): return (S0[0] + wu[0] * d + wp[0] * o, S0[1] + wu[1] * d + wp[1] * o)
wbars = []
d0 = 4.0
while d0 < WL - 8:
    k = d0 / WL
    up, dn = 4.2 - 2.2 * k, 5.4 - 2.8 * k
    wbars.append(f'M{P(*wat(d0, up))}Q{P(*wat(d0 + 1.1, 0))} {P(*wat(d0 + .4, -dn))}')
    d0 += 4.2
wbars = ''.join(wbars)
cbars = ''.join(f'M{P(66.6 + i * 4.6, 64.9 - i * .3)}l{P(-1.2, 5.0)}' for i in range(4))   # the covert band, above the white bar

# ---- head: a circle; the black bridle is the crescent between two circles ----
HC, HR = (93.0, 46.0), 13.4
def circ(c, r, deg): a = math.radians(deg); return (c[0] + r * math.cos(a), c[1] + r * math.sin(a))
Co, Ro, Ci, Ri = (92.5, 46.7), 14.9, (93.5, 45.7), 13.3
o0, o1 = circ(Co, Ro, 198), circ(Co, Ro, 44)
i1, i0 = circ(Ci, Ri, 44), circ(Ci, Ri, 198)
collar = f'M{P(*o0)}A{f(Ro)} {f(Ro)} 0 0 0 {P(*o1)}L{P(*i1)}A{f(Ri)} {f(Ri)} 0 0 1 {P(*i0)}Z'
head = f'M{P(HC[0] - HR, HC[1])}a{f(HR)} {f(HR)} 0 1 1 {f(2 * HR)} 0a{f(HR)} {f(HR)} 0 1 1 {f(-2 * HR)} 0Z'

svg = f'''<svg class="jay-svg" viewBox="0 0 128 128" aria-hidden="true" focusable="false">
  <g class="jay-twig">
    <path class="jay-twig-main" d="M24 109.2C46 105 78 105.6 109 110.4"/>
    <path class="jay-twig-side" d="M89 107.4c4.6-3.4 8.4-7 12.2-11.4"/>
    <path class="jay-twig-shade" d="M27 111C48 107.3 78 107.8 106 112"/>
    <circle class="jay-twig-bud" cx="101.6" cy="95.4" r="1.9"/>
  </g>
  <g class="jay-bird">
    <g class="jay-tail">
      {tail}
    </g>
    <g class="jay-legs">
      <path class="jay-leg" d="M68.4 96 67.4 107M78.2 94.5l.6 12.5"/>
      <path class="jay-toe" d="M63.6 108.8c1.7-2.6 5.9-2.8 7.800-.2M74.800 108.700c1.800-2.600 6-2.600 7.900.1"/>
    </g>
    <path class="jay-back" d="M80 54C70 55 57 66 49 82c-2 5-1 10 4 13 9 5 24 4 33-3 8-6 14-17 13-28-.5-5-3.500-9-8-11z"/>
    <g class="jay-chest">
      <path class="jay-pale jay-edge" d="M99 64c1 11-5 22-13 28-9 7-24 8-33 3-1.800-1.200-3.200-2.700-4.200-4.400C58 92 71 88 79 80c7-6.500 11-14.500 11.500-23 3-1.500 7 1 8.500 7z"/>
      <path class="jay-flank" d="M48.800 90.600C58 92 71 88 79 80c-3.500 7.500-12.500 13.500-23 15.600-3-1-5.400-2.700-7.200-5z"/>
      <path class="jay-wash" d="M90.500 57c3-1.500 7 1 8.500 7 .3 5.500-.8 11-2.800 16-3-6-5.300-14-5.700-23z"/>
    </g>
    <path class="jay-back-shine" d="M77 56.500c-9 2.500-17.500 9.500-23.500 19"/>
    <g class="jay-wing">
      <path class="jay-wing-main" d="M87 61c-7-4-19-2-27 6-6 6-10 14.500-11.500 23 8.500.5 19.500-4 27.500-11 6-5.500 11-11 13-15.500 0-1.200-.8-2.100-2-2.500z"/>
      <path class="jay-wing-tip" d="M48.500 90c.8-6.500 3-12.500 6.500-17.500 1.600 5.500 1.400 12-.6 17.900-2 .2-4 0-5.900-.4z"/>
      <path class="jay-bars" d="{wbars}"/>
      <path class="jay-scap" d="M87 61c-7-4-17.500-2.700-25 3.500 5 3.100 12.500 4.300 19.500 2.500 3.100-1 5.500-3 5.500-6z"/>
      <path class="jay-bars jay-bars-fine" d="{cbars}"/>
      <path class="jay-bar-white" d="M62.400 73.300c7.200-.6 14.200-2.200 20.200-4.800"/>
      <path class="jay-tips-white" d="M54.600 88.600l3.600-1M61.400 86.500l3.400-1.600M67.800 83.300l3-2"/>
      <path class="jay-wing-shine" d="M85.400 62.600c-6-3-14.600-2.400-21.600 1.800"/>
    </g>
    <g class="jay-head">
      <path class="jay-white jay-edge" d="{head}"/>
      <path class="jay-collar" d="{collar}"/>
      <path class="jay-crown" d="M106.200 43.400C104.800 36.600 99.600 32.600 93 32.600c-7.400 0-13.400 5.800-13.400 13.200C83.600 42.400 94.600 39.600 106.200 43.400z"/>
      <g class="jay-crest">
        <path class="jay-crown-top" d="M101.500 35.200C94 30 85 27.300 76 27.200c-1.700 0-2.200 1.100-1.300 2.200 2.800 2.900 4.900 6.400 6 10.300C84.200 37 92 35.200 101.500 35.200z"/>
        <path class="jay-crest-line" d="M79.400 29.400c5.600.5 11 2.100 15.800 4.700M81.600 33.600c2.800.5 5.400 1.400 7.800 2.700"/>
      </g>
      <path class="jay-eyeline" d="M105.400 45.600c-2.200-.8-4-1.100-5.400-1M94.400 45c-4.400.5-9 1.800-12.800 3.600"/>
      <g class="jay-eye"><circle class="jay-ink" cx="97.200" cy="44.400" r="2.700"/><circle class="jay-glint" cx="98.100" cy="43.400" r=".8"/></g>
      <path class="jay-bill" d="M105.400 42.400c4.800.4 10.200 2.200 14 4.900-4.600.3-9.400.4-14.200.2-.5-1.700-.4-3.500.2-5.100z"/>
      <path class="jay-bill-low" d="M105.200 47.500c4.800.2 9.600.1 14.200-.2-3.700 2.400-8.300 3.300-13.200 2.700-.6-.8-.9-1.600-1-2.500z"/>
      <path class="jay-bill-shine" d="M107 43.500c3.900.7 7.300 2 10.100 3.400"/>
      <path class="jay-tuft" d="M104.200 41.600c1.800-.6 3.800 0 4.800 1.300-1.600.2-3 .5-4.400 1z"/>
    </g>
  </g>
</svg>'''
import re
svg = re.sub(r'(\d+\.\d*?[1-9])0+(?=[^\d])', r'\1', svg)   # 7.800 -> 7.8
svg = re.sub(r'(\d+)\.0+(?=[^\d])', r'\1', svg)             # 6.000 -> 6
open(sys.argv[1] if len(sys.argv) > 1 else '/dev/stdout', 'w').write(svg)
