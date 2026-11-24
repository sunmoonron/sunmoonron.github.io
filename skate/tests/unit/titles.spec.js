// Every session title in the live data (2026-11-24, unit/titles.json) lands in a sensible kind of
// skating: nothing but breakdancing in "other" (which the app names Ice Breakdancing), every
// stick & puck title in Stick & puck, every shinny in Pickup. Uses the app's own keyword tables.
const { test, expect } = require('@playwright/test');
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'projects', 'js', 'config.js'), 'utf8'), ctx);
const CFG = ctx.window.SkateConfig;
const { titles } = JSON.parse(fs.readFileSync(path.join(__dirname, 'titles.json'), 'utf8'));
// the same rule as app.js P.category / P.hockeyKind
const category = (t) => { const a = t.toLowerCase(); const hit = CFG.activityTags.find(x => x.keywords.some(k => a.includes(k))); return hit ? hit.cls : 'other'; };
const kind = (t) => { const a = t.toLowerCase(); return /stick\W*(?:and|n)?\W*puck/.test(a) ? 'stickpuck' : /shinny|pick\W?up|drop\W?in hockey/.test(a) ? 'pickup' : 'other'; };

test('nothing but breakdancing is filed under "other"', () => {
    expect(titles.filter(t => category(t.title) === 'other' && !/break\s?danc/i.test(t.title)).map(t => `${t.title} (${t.sources.join(', ')})`)).toEqual([]);
});
test('every hockey title is Pickup or Stick & puck', () => {
    expect(titles.filter(t => category(t.title) === 'hockey' && kind(t.title) === 'other').map(t => t.title)).toEqual([]);
});
test('stick & ring is ringette, sledge hockey is adaptive, 55+ skates are leisure', () => {
    expect(category('Drop-in Stick & Ring')).toBe('ringette');
    expect(category('Sledge Hockey')).toBe('adapted');
    expect(category('55+ Skate')).toBe('leisure');
});
