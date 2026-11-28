// Every source the updater reads must be known to the app: a label and a site for the Data status
// page, a city for the Where filter, its place in the city order and (for Toronto) a status group.
// A source added to fetch-skate-data.js and forgotten here would show as a bare key, or not at all.
const { test, expect } = require('@playwright/test');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { EXTERNAL_SOURCES } = require('../../../fetch-skate-data.js');

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'projects', 'js', 'config.js'), 'utf8'), ctx);
const CFG = ctx.window.SkateConfig;

test('every source has a label, a site and a city in the app', () => {
    const missing = Object.keys(EXTERNAL_SOURCES).filter(k => { const i = CFG.sourceInfo[k]; return !i || !i.city || !(i.label || i.place) || !i.site; });
    expect(missing).toEqual([]);
});
test('every city a source belongs to is in the city order', () => {
    const cities = [...new Set(Object.keys(EXTERNAL_SOURCES).map(k => CFG.sourceInfo[k] && CFG.sourceInfo[k].city).filter(Boolean))];
    expect(cities.filter(c => !CFG.cityOrder.includes(c))).toEqual([]);
});
test('every Toronto source sits in a status group; merged rows point at real sources', () => {
    const grouped = new Set(CFG.sourceGroups.flatMap(g => g.keys));
    expect(Object.keys(EXTERNAL_SOURCES).filter(k => (CFG.sourceInfo[k] || {}).city === 'Toronto' && !grouped.has(k))).toEqual([]);
    expect(Object.keys(CFG.sourceRows).filter(k => !EXTERNAL_SOURCES[k])).toEqual([]);
});
test('no app entry for a source the updater no longer reads', () => {
    expect(Object.keys(CFG.sourceInfo).filter(k => k !== 'city' && !EXTERNAL_SOURCES[k])).toEqual([]);
});

// v3.23: a closing brace left behind by an edit makes the browser drop the rule after it, silently (three
// did, when the old map sheet's styles were cut out: the map popup lost its layout and no test said so).
test('every stylesheet opens and closes its braces evenly', () => {
    const dir = path.join(__dirname, '..', '..', 'assets', 'css');
    const bad = {};
    fs.readdirSync(dir).filter(f => f.endsWith('.css')).forEach(f => {
        const css = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        let depth = 0, stray = 0;
        for (const ch of css) {
            if (ch === '{') depth++;
            else if (ch === '}') { if (depth === 0) stray++; else depth--; }
        }
        if (depth || stray) bad[f] = { unclosed: depth, stray };
    });
    expect(bad).toEqual({});
});
// The page and the app must agree on names: an element the app looks up by id has to be in index.html
// (ids the app creates itself as it goes are listed here).
test('every element the app looks up by id is in the page', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
    const js = fs.readFileSync(path.join(__dirname, '..', '..', 'projects', 'js', 'app.js'), 'utf8');
    const made = new Set(['btn-install-now', 'cf-dms-badge', 'cf-groups-badge', 'cf-muted', 'chats-badge', 'guide-body-text']);
    const used = new Set([...js.matchAll(/\$\('([a-zA-Z0-9_-]+)'\)/g)].map(m => m[1]));
    expect([...used].filter(id => !ids.has(id) && !made.has(id)).sort()).toEqual([]);
});
