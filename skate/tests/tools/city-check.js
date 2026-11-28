// Today's City sessions as the site shows them, held against the City's own rink status feed, rink by rink.
// Not part of the test suite: run it by hand when you want to know whether the banners match the City right now.
//
//   node skate/tests/tools/city-check.js                 (from the repo root: today, outdoor rinks)
//   node skate/tests/tools/city-check.js --all           (indoor arenas too)
//   node skate/tests/tools/city-check.js --day=2026-12-05
//   node skate/tests/tools/city-check.js --local         (the alert logic in this checkout, not the live site's)
//
// It reads the data the live site is serving (schedule, rinks, alerts, the live-schedule cross-check), the alert
// logic (alerts.js: the live copy unless --local), and https://www.toronto.ca/data/parks/live/skate_allupdates.json,
// which is what the City's "Ice Rink Closures & Service Alerts" page is drawn from. Then, for every rink with City
// sessions that day, it prints what the City says and the banner each session gets, and lists what needs a look:
//   - the City says closed and a session there shows no warning
//   - a session is marked off or warned about and the City has nothing posted
//   - the City's notice is newer than, or missing from, the site's copy of the alerts
//   - a notice the logic could not classify, or one that names a pad
// First run: 2026-11-28, opening day of the outdoor season (it found Greenwood Park's "Leisure Closed, Hockey Pad
// Open" being shown as "likely runs on the other pad" on the leisure skate itself).
const fs = require('fs'), os = require('os'), path = require('path');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, d) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : d; };
const SITE = opt('site', 'https://sunmoonron.github.io/skate/');
const DATA = opt('data', 'https://skate-data.ronishbhatt.com/projects/data');
const CITY = 'https://www.toronto.ca/data/parks/live/skate_allupdates.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const torontoDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
const DAY = opt('day', torontoDay());
const get = async (url, as = 'json') => {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return as === 'text' ? res.text() : res.json();
};
const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
    const [sched, rinksFile, alertsFile, live, city] = await Promise.all([
        get(`${DATA}/skating-programs.json`), get(`${DATA}/rinks.json`), get(`${DATA}/alerts.json`), get(`${DATA}/live-check.json`).catch(() => ({})), get(CITY)
    ]);
    // the alert logic: the copy the live site serves (what visitors run), or this checkout's with --local
    let alertsJs = path.join(__dirname, '..', '..', 'projects', 'js', 'alerts.js');
    if (!flag('local')) {
        const html = await get(SITE, 'text');
        const src = (/projects\/js\/alerts\.js\?v=\d+/.exec(html) || ['projects/js/alerts.js'])[0];
        alertsJs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'city-check-')), 'alerts.js');
        fs.writeFileSync(alertsJs, await get(SITE + src, 'text'));
    }
    const rinks = rinksFile.rinks || [], byId = new Map(rinks.map(r => [String(r.locationid), r]));
    global.window = { SkateTime: { todayKey: () => torontoDay() }, SkateGeo: { rinkByLocation: (id) => byId.get(String(id)) || null },
        SkateAPI: { fetchJson: async (file) => (/live-check/.test(file) ? live : alertsFile) } };
    global.SkateAPI = global.window.SkateAPI;
    const SA = require(alertsJs);
    await SA.load(true);

    const cityNow = new Map();      // location id → the City's notices right now
    Object.values(city.locations || {}).forEach(list => (list || []).forEach(x => { const k = String(x.LocationID); if (!cityNow.has(k)) cityNow.set(k, []); cityNow.get(k).push(x); }));
    const ours = new Map();
    (alertsFile.alerts || []).forEach(a => { const k = String(a.LocationID); if (!ours.has(k)) ours.set(k, []); ours.get(k).push(a); });
    const sig = (x) => `${x.AssetID}|${x.Status}|${x.Reason || ''}|${x.PostedDate}`;

    const sessions = (sched.programs || []).filter(p => String(p['Start Date']).slice(0, 10) === DAY && (!p.Source || p.Source === 'city'))
        .filter(p => { const r = byId.get(String(p['Location ID'])); return flag('all') || (r && (r.kinds || []).includes('outdoor')); });
    const groups = new Map();
    sessions.forEach(p => { const k = String(p['Location ID']); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
    const look = [], tally = {};
    const lines = [];
    for (const [id, list] of [...groups.entries()].sort((a, b) => String((byId.get(a[0]) || {}).name).localeCompare(String((byId.get(b[0]) || {}).name)))) {
        const r = byId.get(id) || { name: `location ${id}`, pads: 1 };
        const cityList = (cityNow.get(id) || []).filter(x => /rink|ice|skat/i.test(`${x.Type} ${x.AssetName} ${x.Category}`));
        const banners = list.sort((a, b) => String(a['Start Time']).localeCompare(String(b['Start Time']))).map(p => {
            const v = SA.forProgram(p);
            const b = v ? `${v.level}/${v.kind}` : 'none';
            tally[b] = (tally[b] || 0) + 1;
            return { title: p['Course Title'], time: `${p['Start Time']}-${p['End Time']}`, b, lead: v ? (v.lead || v.reason || '') : '' };
        });
        const kinds = [...new Set(banners.map(x => x.b))];
        const cityClosed = cityList.filter(x => String(x.Status) === '0');
        const seasonal = (x) => /closed for the season/i.test(`${x.Reason} ${x.Comments}`);
        // what needs a look
        const mine = new Set((ours.get(id) || []).filter(a => a.Scope !== 'facility').map(sig));
        cityList.forEach(x => { if (!mine.has(sig(x))) look.push(`${r.name}: the City's notice "${x.Reason || clean(x.Comments).slice(0, 60)}" (posted ${String(x.PostedDate).slice(5, 16)}) is not in the site's copy of the alerts yet`); });
        if (cityClosed.some(x => !seasonal(x)) && banners.some(x => x.b === 'none' || x.b.startsWith('note/')) && !banners.every(x => x.b === 'note/pad-other' || x.b.startsWith('closed/')))
            look.push(`${r.name}: the City says closed (${cityClosed.filter(x => !seasonal(x)).map(x => x.Reason).join(', ')}) and ${banners.filter(x => x.b === 'none' || x.b.startsWith('note/')).length} session(s) there carry no warning`);
        if (!cityList.length && banners.some(x => x.b !== 'none' && x.b !== 'closed/live'))
            look.push(`${r.name}: sessions are marked ${kinds.filter(k => k !== 'none').join(', ')} and the City has nothing posted now`);
        if (kinds.some(k => k === 'warning/alert' || k === 'warning/pad')) look.push(`${r.name}: a notice the logic could not place (${kinds.join(', ')}): ${cityList.map(x => `"${x.Reason}: ${clean(x.Comments).slice(0, 80)}"`).join(' ; ')}`);
        if (cityList.some(x => /\b(leisure|pleasure|hockey|shinny)\b[^.]*\b(closed|open)\b/i.test(`${x.Reason} ${clean(x.Comments)}`))) look.push(`${r.name}: the notice names a pad ("${cityList.map(x => x.Reason).join('; ')}"): ${banners.map(x => `${x.title} → ${x.b}`).join(' | ')}`);
        lines.push(`${String(r.name).slice(0, 38).padEnd(38)} ${String(list.length).padStart(2)}  ${kinds.join(' + ').padEnd(36)} ${cityList.length ? cityList.map(x => `${String(x.Status) === '0' ? 'CLOSED' : 'alert'}: ${x.Reason || ''}${clean(x.Comments) ? ' — ' + clean(x.Comments).slice(0, 50) : ''} (${String(x.PostedDate).slice(5, 16)})`).join(' ; ') : 'nothing posted'}`);
    }
    console.log(`${DAY}: ${sessions.length} City sessions at ${groups.size} ${flag('all') ? '' : 'outdoor '}rinks. Site alerts copied ${String(alertsFile.checkedAt || alertsFile.fetchedAt || '?').slice(0, 16)}Z, logic: ${flag('local') ? 'this checkout' : 'the live site'}.`);
    console.log(`${'RINK'.padEnd(38)}  N  ${'BANNER(S) ON ITS SESSIONS'.padEnd(36)} THE CITY SAYS NOW`);
    lines.forEach(l => console.log(l));
    console.log('\nBanners:', Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(', '));
    const noSessions = [...cityNow.entries()].filter(([id, l]) => !groups.has(id) && l.some(x => String(x.Status) === '0' && !/closed for the season/i.test(`${x.Reason} ${x.Comments}`) && (flag('all') || /outdoor/i.test(`${x.Type} ${x.AssetName}`))));
    if (noSessions.length) console.log('Closed by the City with no sessions listed that day:', noSessions.map(([id, l]) => `${clean(l[0].AssetName).split(' - ')[0]} (${l[0].Reason})`).join(', '));
    console.log(look.length ? `\nTO LOOK AT (${look.length}):\n- ${look.join('\n- ')}` : '\nNothing stands out: every banner follows from what the City has posted.');
})().catch(e => { console.error('city-check failed:', e.message); process.exit(1); });
