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
