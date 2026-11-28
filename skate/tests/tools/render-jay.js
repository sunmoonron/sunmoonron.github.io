// Renders the blue jay large and at its real size (40px), light and dark, to a PNG, to look at while redrawing it.
// Not part of the site or the test suite. From the repo root:
//   node skate/tests/tools/render-jay.js <svg-file | bird> <out.png>      ("bird" = the drawing bird.js holds now)
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { chromium } = require(path.join(ROOT, 'node_modules/@playwright/test'));
(async () => {
    const src = process.argv[2], out = process.argv[3];
    const css = fs.readFileSync(path.join(ROOT, 'skate/assets/css/style-v3.css'), 'utf8').split('\n').filter(l => /jay-svg/.test(l) || /^\s+--jay-/.test(l)).join('\n');
    let svg;
    if (src === 'bird') { const js = fs.readFileSync(path.join(ROOT, 'skate/projects/js/bird.js'), 'utf8'); svg = js.slice(js.indexOf('<svg class="jay-svg"'), js.indexOf('</svg>') + 6); }
    else svg = fs.readFileSync(src, 'utf8');
    const cell = (cls, size, label) => `<div class="cell ${cls}"><div style="width:${size}px;height:${size}px">${svg}</div><small>${label}</small></div>`;
    const html = `<!doctype html><meta charset="utf-8"><style>
        body{margin:0;font:12px system-ui;display:flex;flex-wrap:wrap}
        .cell{padding:18px;display:flex;flex-direction:column;align-items:center;gap:6px}
        .light{background:#fff;color:#333}.dark{background:#17222d;color:#ccd}
        ${css}
        .dark .jay-svg{--jay-back:#7b9be0;--jay-crown:#6f95e4;--jay-crown-top:#6990e4;--jay-crest-line:#4f76c6;--jay-wing:#3f95f4;--jay-wing-deep:#2a69c2;--jay-scap:#8aa6e4;--jay-tail:#4196f4;--jay-tail-deep:#3580de;--jay-edge:transparent;--jay-bill:#3a4459;--jay-bill-low:#485268;--jay-legs:#7b8698;--jay-twig:#a98862;--jay-twig-dark:#7d6245}
    </style><body>${cell('light', 360, 'light 360')}${cell('dark', 360, 'dark 360')}${cell('light', 80, '80')}${cell('light', 40, '40 (real)')}${cell('dark', 80, '80')}${cell('dark', 40, '40 (real)')}</body>`;
    const b = await chromium.launch();
    const p = await b.newPage({ viewport: { width: 1100, height: 560 }, deviceScaleFactor: 2 });
    await p.setContent(html);
    await p.screenshot({ path: out });
    await b.close();
    console.log('wrote', out);
})();
