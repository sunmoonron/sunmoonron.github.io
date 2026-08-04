#!/usr/bin/env node
/**
 * Data Fetcher Script - Downloads City of Toronto Recreation Data
 * plus external rink sources (Canlan York, Moss Park Arena), the city
 * rink inventory (indoor + outdoor pads → rinks.json) and live skate
 * service alerts (→ alerts.json).
 *
 * Usage:
 *   node fetch-skate-data.js                # full refresh (programs + rinks + alerts)
 *   node fetch-skate-data.js --alerts-only  # just refresh alerts.json (cheap, run often)
 *
 * toronto.ca live endpoints send no Access-Control-Allow-Origin header,
 * so the browser can never fetch them directly — CI snapshots them here.
 *
 * Design rules:
 *  - City drop-in data failing is FATAL (keeps the previous files intact).
 *  - Any external source failing is a WARNING: its previous records are
 *    salvaged from the existing skating-programs.json so one flaky API
 *    never wipes a source off the site.
 *  - Every external source lives in EXTERNAL_SOURCES — adding a rink is
 *    a config entry + (if it's a new kind) a fetcher, nothing else.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const PACKAGE_ID = '1a5be46a-4039-48cd-a2d2-8e702abf9516';
const BASE_URL = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action';
// Script lives at the repo root, but the app reads from skate/projects/data/
const OUTPUT_DIR = path.join(__dirname, 'skate', 'projects', 'data');

const ALERTS_ONLY = process.argv.includes('--alerts-only');

/* ================= External source registry =================
 * kind 'daysmart' — DaySmart Recreation JSON:API (Canlan etc.)
 * kind 'scrape'   — HTML page with a human schedule (regex parse,
 *                   optional LLM assist via ANTHROPIC_API_KEY)
 * Common fields land on every generated program record so the client
 * renders them exactly like city records (+ Paid/Unverified extras).
 */
const EXTERNAL_SOURCES = {
    'canlan-york': {
        kind: 'daysmart',
        company: 'canlan',
        // Rinks 1-6 at NFP Athletic Centre (York) — facility_id 5.
        // (filter[facility_ids] is silently ignored by their API, so we
        //  filter by the ice-rink resource ids instead.)
        resourceIds: [3, 4, 5, 6, 7, 8],
        daysAhead: 28,
        // Which published events to keep, and how to label them.
        programs: [
            { match: /public\s*skat/i, activity: 'Public Skate', defaultPrice: 5 }
        ],
        locationName: 'NFP Athletic Centre (Canlan York)',
        address: '989 Murray Ross Pkwy',
        district: 'North York',
        postalCode: 'M3J 3M4',
        lat: 43.7747279, lng: -79.5137961,
        paid: true,
        registrationUrl: (date) => `https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?date=${date}&facility_ids=5&program_types=51`,
        infoUrl: 'https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?facility_ids=5&program_types=51'
    },
    'mosspark': {
        kind: 'scrape',
        url: 'https://mossparkarena.com/home/skating/public-skating/',
        daysAhead: 28,
        activity: 'Public Skating (Free)',
        locationName: 'Moss Park Arena',
        // City locationid 3491 (board-operated arena) — lets the client
        // match toronto.ca service alerts even though the schedule is scraped.
        locationId: 3491,
        address: '140 Sherbourne St',
        district: 'Toronto and East York',
        postalCode: 'M5A 3S5',
        lat: 43.6550295646, lng: -79.3702954334,
        paid: false,
        unverified: true,     // schedule comes from their website, no live feed → tell users to double-check
        infoUrl: 'https://mossparkarena.com/home/skating/public-skating/'
    }
};

const RINK_PACKAGES = [
    { id: 'indoor-ice-rinks', kind: 'indoor' },
    { id: 'outdoor-artificial-ice-rinks', kind: 'outdoor' }
];

const ALERTS_URL = 'https://www.toronto.ca/data/parks/live/skate_allupdates.json';

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/* ================= HTTP helpers ================= */

/** GET url → raw text (follows up to 3 redirects, no deps). */
function httpGetText(url, headers = {}, redirects = 0) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'toronto-skating-site-data-fetcher', ...headers } }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
                res.resume();
                return resolve(httpGetText(new URL(res.headers.location, url).href, headers, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url.substring(0, 90)}`));
            }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(45000, () => req.destroy(new Error(`Timeout for ${url.substring(0, 90)}`)));
    });
}

/**
 * Make HTTPS request and return JSON
 */
async function fetchJSON(url, headers = {}) {
    console.log(`Fetching: ${url.substring(0, 80)}...`);
    const text = await httpGetText(url, headers);
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`Failed to parse JSON: ${e.message}`);
    }
}

/* ================= Toronto-time helpers (CI runs in UTC) ================= */

const TORONTO_TZ = 'America/Toronto';

/** 'YYYY-MM-DD' for a Date, in Toronto local time. */
function torontoDateStr(d = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TORONTO_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Weekday name for a 'YYYY-MM-DD' string (date-only math, no TZ drift). */
function weekdayOf(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** dateStr + n days → 'YYYY-MM-DD' (date-only math). */
function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
}

/* ================= City drop-in programs (existing pipeline) ================= */

/**
 * Fetch all records from a datastore resource with pagination
 */
async function fetchAllRecords(resourceId, resourceName) {
    let allRecords = [];
    let offset = 0;
    const limit = 10000; // Larger batch for efficiency
    let total = Infinity;

    console.log(`\n📥 Fetching ${resourceName}...`);

    while (offset < total) {
        const url = `${BASE_URL}/datastore_search?id=${resourceId}&limit=${limit}&offset=${offset}`;
        const result = await fetchJSON(url);

        if (result.success) {
            allRecords = allRecords.concat(result.result.records);
            total = result.result.total;
            console.log(`   Progress: ${allRecords.length}/${total} records`);
        } else {
            throw new Error(`API returned error for ${resourceName}`);
        }

        offset += limit;

        // Small delay to be nice to the server
        await new Promise(r => setTimeout(r, 100));
    }

    console.log(`   ✅ Complete: ${allRecords.length} records`);
    return allRecords;
}

/**
 * Filter for ICE-skating programs only.
 *
 * The city's ice programs all live under Section "Skate - Drop-In" /
 * "Skating - Drop-In"; the title keywords are only a fallback in case a
 * future section is named differently. NON_ICE guards the fallback from
 * gym/pavement sports that share hockey vocabulary — "Ball Hockey" alone
 * was 78 records of bloat on an ice-skating site.
 */
const NON_ICE = /(ball|floor|street|road|dek|cosom)\s*hockey|skateboard|inline|roller/i;

function filterSkatingPrograms(programs) {
    return programs.filter(p => {
        // Field names from the actual API
        const courseTitle = (p['Course Title'] || '').toLowerCase();
        const section = (p['Section'] || '').toLowerCase();

        if (NON_ICE.test(courseTitle) || NON_ICE.test(section)) return false;
        return section.includes('skat') ||
               courseTitle.includes('skate') ||
               courseTitle.includes('shinny') ||
               courseTitle.includes('hockey') ||
               courseTitle.includes('ringette') ||
               courseTitle.includes('stick and puck');
    });
}

/** "13" → 13, "None"/""/garbage → null (the raw feed mixes all three). */
function cleanAge(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
}

/* ================= Rink inventory → rinks.json ================= */

function titleCaseIfShouty(s) {
    if (!s || s !== s.toUpperCase()) return s || '';
    return s.toLowerCase().replace(/(^|[\s\-\/('.])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
}

/**
 * Fetch indoor + outdoor rink datasets and group pads by city locationid.
 * Gives the client: coordinates (nearest-rink locator), pad kinds
 * (indoor/outdoor — needed to judge whether a "Closed for the Season"
 * alert on the outdoor pad affects an indoor program), and the full rink
 * universe including rinks with no scheduled drop-ins.
 */
async function fetchRinkInventory() {
    const byLocation = {};

    for (const pkg of RINK_PACKAGES) {
        const packageData = await fetchJSON(`${BASE_URL}/package_show?id=${pkg.id}`);
        if (!packageData.success) throw new Error(`Failed package_show for ${pkg.id}`);
        const resource = packageData.result.resources.find(r => r.datastore_active);
        if (!resource) throw new Error(`No datastore resource in ${pkg.id}`);
        const records = await fetchAllRecords(resource.id, `${pkg.id} pads`);

        records.forEach(r => {
            const locId = String(r.locationid || '').trim();
            if (!locId || locId === 'None') return;
            let lat = null, lng = null;
            try {
                const geo = JSON.parse(r.geometry);
                if (geo?.coordinates) { lng = geo.coordinates[0]; lat = geo.coordinates[1]; }
            } catch {}
            const entry = byLocation[locId] ||= {
                locationid: locId,
                name: titleCaseIfShouty(r['Parent Asset Name']) || r['Public Name'] || '',
                address: titleCaseIfShouty(r['Address'] || ''),
                postal: r['Postal Code'] && r['Postal Code'] !== 'None' ? r['Postal Code'] : '',
                district: r['Community Council Area'] || '',
                lat, lng,
                kinds: [],
                pads: 0,
                operator: r['Operated By'] || '',
                source: 'city'
            };
            entry.pads += 1;
            if (!entry.kinds.includes(pkg.kind)) entry.kinds.push(pkg.kind);
            if (entry.lat == null && lat != null) { entry.lat = lat; entry.lng = lng; }
        });
    }

    // External sources join the same universe (locator + calendar need them).
    Object.entries(EXTERNAL_SOURCES).forEach(([key, cfg]) => {
        const locId = cfg.locationId ? String(cfg.locationId) : `ext-${key}`;
        const existing = byLocation[locId];
        if (existing) {
            // City already lists it (e.g. Moss Park) — just mark the external link.
            existing.website = cfg.infoUrl;
            existing.externalSource = key;
            if (cfg.paid) existing.paid = true;
        } else {
            byLocation[locId] = {
                locationid: locId,
                name: cfg.locationName,
                address: cfg.address,
                postal: cfg.postalCode || '',
                district: cfg.district || '',
                lat: cfg.lat, lng: cfg.lng,
                kinds: ['indoor'],
                pads: cfg.resourceIds ? cfg.resourceIds.length : 1,
                operator: 'External',
                source: 'external',
                externalSource: key,
                website: cfg.infoUrl,
                paid: !!cfg.paid
            };
        }
    });

    return Object.values(byLocation).sort((a, b) => a.name.localeCompare(b.name));
}

/* ================= Service alerts → alerts.json ================= */

/**
 * Snapshot toronto.ca live skate alerts. Only writes the file when alert
 * CONTENT changed, so the 30-min CI tick doesn't spam commits.
 * Returns { changed, count }.
 */
async function fetchAlerts() {
    console.log('\n🚨 Fetching skate service alerts...');
    const raw = await fetchJSON(ALERTS_URL);
    const all = [];
    Object.values(raw.locations || {}).forEach(list => {
        (list || []).forEach(a => {
            // Guard: the feed occasionally contains malformed rows
            if (!a || a.LocationID == null || a.Status == null) return;
            all.push({
                LocationID: a.LocationID,
                AssetID: a.AssetID ?? null,
                AssetName: a.AssetName || '',
                Reason: a.Reason || '',
                Comments: a.Comments || '',
                Status: a.Status,
                Category: a.Category || '',
                Type: a.Type || '',
                // The city's Category taxonomy drifts between feeds
                // ("Skate" in the aggregate, "Indoor Ice Rink" in the
                // per-location feed) — carry DisplayAlertName too so the
                // client can match on any of them.
                DisplayAlertName: a.DisplayAlertName || '',
                PostedDate: a.PostedDate || ''
            });
        });
    });
    // Stable order → stable diffs
    all.sort((a, b) => (a.LocationID - b.LocationID) || String(a.AssetID).localeCompare(String(b.AssetID)));

    const alertsFile = path.join(OUTPUT_DIR, 'alerts.json');
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(alertsFile, 'utf8')); } catch {}

    const now = new Date().toISOString();
    const changed = !previous || JSON.stringify(previous.alerts) !== JSON.stringify(all);
    // Heartbeat: even with no content change, refresh checkedAt every ~2h so
    // clients can tell "feed quiet" apart from "checker dead" and warn people
    // before they travel on stale data. ≤12 commits/day of overhead.
    const lastChecked = previous?.checkedAt || previous?.fetchedAt;
    const heartbeatDue = !lastChecked || (Date.now() - new Date(lastChecked).getTime()) > 2 * 3600 * 1000;

    if (changed || heartbeatDue) {
        fs.writeFileSync(alertsFile, JSON.stringify({
            fetchedAt: changed ? now : (previous?.fetchedAt || now),  // last CONTENT change
            checkedAt: now,                                           // last successful check
            source: 'toronto.ca live parks data',
            alerts: all
        }));
        console.log(changed
            ? `   ✅ alerts.json updated (${all.length} alerts)`
            : `   💓 alerts heartbeat stamped (${all.length} alerts, unchanged)`);
    } else {
        console.log(`   ⏸  alerts unchanged (${all.length} alerts) — file not rewritten`);
    }
    return { changed: changed || heartbeatDue, count: all.length };
}

/* ================= External source fetchers ================= */

/** Shared shape for generated program records (mirrors the city schema). */
function externalRecord(cfg, sourceKey, { activity, date, startTime, endTime, price, externalId }) {
    return {
        _id: `${sourceKey}-${externalId || `${date}-${startTime}`}`,
        'Location ID': cfg.locationId || null,
        'Course Title': activity,
        Section: 'Skating - Drop-In',
        Activity: activity,
        Category: 'Skating - Drop-In',
        LocationName: cfg.locationName,
        LocationType: 'arena',
        Address: cfg.address || '',
        District: cfg.district || '',
        PostalCode: cfg.postalCode || '',
        Accessibility: '', TTCInfo: '', Intersection: '',
        'Start Time': startTime,
        'End Time': endTime,
        'Day of Week': weekdayOf(date),
        'Start Date': date,
        'End Date': date,
        'First Date': date,
        'Last Date': date,
        // ---- extras the client understands ----
        Source: sourceKey,
        // Venue-system event id (e.g. DaySmart event id) — lets the client
        // fetch LIVE per-session data like spots remaining (their API is
        // CORS-open, unlike toronto.ca's).
        ExternalId: externalId != null ? String(externalId) : null,
        Paid: !!cfg.paid,
        Price: cfg.paid ? (price ?? null) : 0,
        RegistrationUrl: cfg.registrationUrl ? cfg.registrationUrl(date) : (cfg.infoUrl || ''),
        InfoUrl: cfg.infoUrl || '',
        Unverified: !!cfg.unverified,
        Lat: cfg.lat, Lng: cfg.lng
    };
}

/** DaySmart Recreation (Canlan): published events on the configured rinks. */
async function fetchDaySmart(sourceKey, cfg) {
    const start = torontoDateStr();
    const end = addDays(start, cfg.daysAhead);
    const url = `https://api.daysmartrecreation.com/v1/events?cache%5Bsave%5D=false` +
        `&filter%5Bresource_id__in%5D=${cfg.resourceIds.join(',')}` +
        `&filter%5Bstart_date__gte%5D=${start}&filter%5Bstart_date__lte%5D=${end}` +
        `&filter%5Bpublish%5D=1&page%5Bsize%5D=200&sort=start` +
        `&include=homeTeam.product&company=${cfg.company}`;
    const json = await fetchJSON(url, { Accept: 'application/vnd.api+json' });

    // team id → product price (the $ shown on their registration page)
    const teams = {}, products = {};
    (json.included || []).forEach(i => {
        if (i.type === 'teams') teams[i.id] = i.attributes;
        if (i.type === 'products') products[i.id] = i.attributes;
    });
    const priceForTeam = (teamId) => {
        const t = teams[teamId];
        const p = t && products[t.product_id];
        const price = p && (p.actual_price ?? p.price);
        return (typeof price === 'number' && price > 0) ? price : null;
    };

    const records = [];
    (json.data || []).forEach(e => {
        const a = e.attributes;
        const rule = cfg.programs.find(r => r.match.test(a.desc || ''));
        if (!rule) return;
        // `start`/`end` are facility-local (America/Toronto) naive timestamps
        const date = String(a.start).slice(0, 10);
        const startTime = String(a.start).slice(11, 16);
        const endTime = String(a.end).slice(11, 16);
        if (!date || !startTime) return;
        records.push(externalRecord(cfg, sourceKey, {
            activity: rule.activity || a.desc.trim(),
            date, startTime, endTime,
            price: priceForTeam(a.hteam_id) ?? rule.defaultPrice ?? null,
            externalId: e.id
        }));
    });
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions (${start} → ${end})`);
    return records;
}

/* ---- Moss Park (and future scraped venues) ---- */

function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#8211;|&ndash;|&#8212;|&mdash;/g, '–')
        .replace(/&#8217;|&rsquo;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

/** '12', '12:30', '12noon' + am/pm/noon → 'HH:MM' 24h. `assumePm` for bare hours in schedule context. */
function to24h(hStr, mStr, suffix, assumePm = true) {
    let h = parseInt(hStr, 10);
    const m = mStr ? parseInt(mStr, 10) : 0;
    const suf = (suffix || '').toLowerCase();
    if (suf === 'noon') h = 12;
    else if (suf === 'am') { if (h === 12) h = 0; }
    else if (suf === 'pm') { if (h !== 12) h += 12; }
    else if (assumePm && h >= 1 && h <= 6) h += 12; // "1 – 2" on an arena page means afternoon
    if (h > 23 || m > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/**
 * Heuristic parser for human schedule text like:
 *   "Tuesday: 12 – 1 pm Thursdays: 1 – 2 pm
 *    New Saturday's June 27 to July 18 2026 from 12noon to 2pm"
 * Returns rules: [{weekday, start, end, from?, to?}] (from/to = 'YYYY-MM-DD' bounds).
 */
function parseScheduleText(text) {
    const rules = [];
    const dayRe = /(Sun|Mon|Tues?|Wednes|Thurs?|Fri|Satur)day(?:'?s)?/gi;
    const timeRangeRe = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|noon)?\s*(?:–|—|-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|noon)?/i;
    const dateRangeRe = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(\d{4}))?\s+to\s+(?:(January|February|March|April|May|June|July|August|September|October|November|December)\s+)?(\d{1,2}),?\s*(\d{4})/i;

    // Split into segments, one per weekday mention; a segment runs until the next weekday mention.
    const matches = [...text.matchAll(dayRe)];
    matches.forEach((m, i) => {
        const segment = text.slice(m.index, matches[i + 1] ? matches[i + 1].index : text.length);
        const time = segment.match(timeRangeRe);
        if (!time) return;
        const start = to24h(time[1], time[2], time[3]);
        // End inherits start's meridiem when it has none and would otherwise be before start
        let end = to24h(time[4], time[5], time[6]);
        if (start && end && end <= start) {
            const bumped = to24h(time[4], time[5], 'pm');
            if (bumped && bumped > start) end = bumped;
        }
        if (!start || !end || end <= start) return;

        const dayToken = m[1].toLowerCase();
        const weekday = WEEKDAYS.find(w => w.toLowerCase().startsWith(dayToken.slice(0, 3)));
        if (!weekday) return;

        const rule = { weekday, start, end };
        const dr = segment.match(dateRangeRe);
        if (dr) {
            const y2 = parseInt(dr[6], 10);
            const y1 = dr[3] ? parseInt(dr[3], 10) : y2;
            const m1 = MONTHS[dr[1].toLowerCase()], m2 = dr[4] ? MONTHS[dr[4].toLowerCase()] : m1;
            rule.from = `${y1}-${String(m1).padStart(2, '0')}-${String(parseInt(dr[2], 10)).padStart(2, '0')}`;
            rule.to = `${y2}-${String(m2).padStart(2, '0')}-${String(parseInt(dr[5], 10)).padStart(2, '0')}`;
        }
        rules.push(rule);
    });

    // Dedupe identical weekday+times (page repeats itself in nav/footers sometimes)
    const seen = new Set();
    return rules.filter(r => {
        const k = `${r.weekday}|${r.start}|${r.end}|${r.from || ''}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/**
 * Optional LLM assist: if ANTHROPIC_API_KEY is set, ask Claude to read the
 * scraped page text and return the schedule as strict JSON. Falls back to
 * the regex parser on ANY failure — the pipeline never depends on the key.
 */
async function llmParseSchedule(text) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    try {
        const body = JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1000,
            messages: [{
                role: 'user',
                content: `Extract the public skating schedule from this arena webpage text. Reply with ONLY a JSON array, no prose. Each item: {"weekday":"Monday".."Sunday","start":"HH:MM","end":"HH:MM"(24h),"from":"YYYY-MM-DD"(optional, only if that line is limited to a date range),"to":"YYYY-MM-DD"(optional)}. Times like "12 – 1 pm" are 12:00-13:00. If a line says a special range like "Saturdays June 27 to July 18 2026 from 12noon to 2pm", include from/to.\n\nPAGE TEXT:\n${text.slice(0, 4000)}`
            }]
        });
        const res = await new Promise((resolve, reject) => {
            const req = https.request('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': key, 'anthropic-version': '2023-06-01',
                    'content-type': 'application/json', 'content-length': Buffer.byteLength(body)
                }
            }, (r) => {
                let d = '';
                r.on('data', c => d += c);
                r.on('end', () => resolve(d));
                r.on('error', reject);
            });
            req.on('error', reject);
            req.setTimeout(30000, () => req.destroy(new Error('LLM timeout')));
            req.write(body); req.end();
        });
        const parsed = JSON.parse(res);
        const textOut = parsed.content?.[0]?.text || '';
        const jsonMatch = textOut.match(/\[[\s\S]*\]/);
        const rules = JSON.parse(jsonMatch ? jsonMatch[0] : textOut);
        if (!Array.isArray(rules)) return null;
        const ok = rules.filter(r => WEEKDAYS.includes(r.weekday) && /^\d{2}:\d{2}$/.test(r.start || '') && /^\d{2}:\d{2}$/.test(r.end || ''));
        console.log(`   🤖 LLM parsed ${ok.length} schedule rules`);
        return ok.length ? ok : null;
    } catch (e) {
        console.warn(`   🤖 LLM parse skipped (${e.message}) — using regex parser`);
        return null;
    }
}

/** Scraped venue: parse recurring rules, expand into dated sessions. */
async function fetchScraped(sourceKey, cfg) {
    const html = await httpGetText(cfg.url);
    // Prefer the page's main content region; fall back to whole page text
    const contentMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)(?:<\/article>|<footer|<aside)/i);
    const text = stripHtml(contentMatch ? contentMatch[1] : html);
    console.log(`   📄 ${sourceKey} page text: "${text.slice(0, 160)}…"`);

    const rules = (await llmParseSchedule(text)) || parseScheduleText(text);
    if (!rules.length) throw new Error('no schedule rules parsed from page');
    console.log(`   📋 rules: ${rules.map(r => `${r.weekday} ${r.start}-${r.end}${r.from ? ` (${r.from}→${r.to})` : ''}`).join(', ')}`);

    const today = torontoDateStr();
    const records = [];
    for (let i = 0; i < cfg.daysAhead; i++) {
        const date = addDays(today, i);
        const weekday = weekdayOf(date);
        rules.forEach(r => {
            if (r.weekday !== weekday) return;
            if (r.from && date < r.from) return;
            if (r.to && date > r.to) return;
            records.push(externalRecord(cfg, sourceKey, {
                activity: cfg.activity, date, startTime: r.start, endTime: r.end
            }));
        });
    }
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions over next ${cfg.daysAhead} days`);
    return records;
}

/** If a source fails today, keep its still-future records from the previous file. */
function salvageExisting(sourceKey) {
    try {
        const prev = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'skating-programs.json'), 'utf8'));
        const today = torontoDateStr();
        const kept = (prev.programs || []).filter(p => p.Source === sourceKey && (p['Start Date'] || '') >= today);
        if (kept.length) console.log(`   ♻️  salvaged ${kept.length} previous ${sourceKey} records`);
        return kept;
    } catch {
        return [];
    }
}

async function fetchExternalSources() {
    const bySource = {};
    for (const [key, cfg] of Object.entries(EXTERNAL_SOURCES)) {
        console.log(`\n🌐 External source: ${key}`);
        try {
            bySource[key] = { ok: true, records: cfg.kind === 'daysmart' ? await fetchDaySmart(key, cfg) : await fetchScraped(key, cfg) };
        } catch (e) {
            console.warn(`   ⚠️ ${key} failed: ${e.message}`);
            bySource[key] = { ok: false, error: e.message, records: salvageExisting(key) };
        }
    }
    return bySource;
}

/* ================= Main ================= */

async function main() {
    console.log('🛼 Toronto Skating Data Fetcher');
    console.log('================================\n');

    try {
        if (ALERTS_ONLY) {
            await fetchAlerts();
            console.log('\n✨ Alerts-only run complete.');
            return;
        }

        // Step 1: Get package info to find resource IDs
        console.log('📋 Fetching package metadata...');
        const packageData = await fetchJSON(`${BASE_URL}/package_show?id=${PACKAGE_ID}`);

        if (!packageData.success) {
            throw new Error('Failed to fetch package info');
        }

        const resources = packageData.result.resources.filter(r => r.datastore_active);
        console.log(`   Found ${resources.length} datastore resources\n`);

        // Identify each resource
        const resourceMap = {};
        resources.forEach(r => {
            const name = r.name.toLowerCase();
            if (name.includes('drop')) resourceMap.dropin = r;
            else if (name.includes('registered')) resourceMap.registered = r;
            else if (name.includes('location')) resourceMap.locations = r;
        });

        console.log('Resources identified:');
        Object.entries(resourceMap).forEach(([key, r]) => {
            console.log(`   - ${key}: ${r.name} (${r.id})`);
        });

        // Step 2: Fetch each dataset
        const datasets = {};

        // Locations (we need this for all programs)
        if (resourceMap.locations) {
            datasets.locations = await fetchAllRecords(resourceMap.locations.id, 'Locations');
        }

        // Drop-in programs (main focus for skating)
        if (resourceMap.dropin) {
            const allDropin = await fetchAllRecords(resourceMap.dropin.id, 'Drop-in Programs');
            datasets.dropin = filterSkatingPrograms(allDropin);
            console.log(`   🎯 Filtered to ${datasets.dropin.length} skating programs`);
        }

        // Step 3: Create a combined skating dataset with location info
        console.log('\n🔗 Joining skating programs with location data...');

        // Create location lookup map (check actual field names)
        const locationMap = {};
        if (datasets.locations) {
            datasets.locations.forEach(loc => {
                // Location ID can be in different formats
                const locId = loc['Location ID'] || loc.LocationID || loc.locationid;
                if (locId) locationMap[locId] = loc;
            });
            console.log(`   Built location map with ${Object.keys(locationMap).length} entries`);
        }

        // Enrich skating programs with location data
        const enrichedPrograms = datasets.dropin.map(program => {
            const locId = program['Location ID'] || program.LocationID;
            const location = locationMap[locId] || {};

            // Build address from components
            let address = '';
            if (location['Street No'] && location['Street No'] !== 'None') {
                address = location['Street No'];
                if (location['Street No Suffix'] && location['Street No Suffix'] !== 'None') {
                    address += location['Street No Suffix'];
                }
                address += ' ';
            }
            if (location['Street Name']) address += location['Street Name'] + ' ';
            if (location['Street Type']) address += location['Street Type'] + ' ';
            if (location['Street Direction'] && location['Street Direction'] !== 'None') {
                address += location['Street Direction'];
            }
            address = address.trim();

            return {
                ...program,
                // Normalize field names for the frontend
                Activity: program['Course Title'],
                Category: program['Section'],
                // Ages arrive as "13" / "None" / "" — make them numbers or null
                // (the string "None" both looked awful in badges and silently
                // broke the numeric age filter)
                'Age Min': cleanAge(program['Age Min']),
                'Age Max': cleanAge(program['Age Max']),
                LocationName: location['Location Name'] || '',
                LocationType: location['Location Type'] || '',
                Address: address,
                District: location['District'] || '',
                PostalCode: location['Postal Code'] !== 'None' ? location['Postal Code'] : '',
                Accessibility: location['Accessibility'] !== 'None' ? location['Accessibility'] : '',
                TTCInfo: location['TTC Information'] !== 'None' ? location['TTC Information'] : '',
                Intersection: location['Intersection'] !== 'None' ? location['Intersection'] : '',
                // Normalize time fields
                'Start Time': program['Start Hour'] !== undefined ?
                    `${String(program['Start Hour']).padStart(2, '0')}:${String(program['Start Minute'] || 0).padStart(2, '0')}` : '',
                'End Time': program['End Hour'] !== undefined ?
                    `${String(program['End Hour']).padStart(2, '0')}:${String(program['End Min'] || 0).padStart(2, '0')}` : '',
                'Day of Week': program['DayOftheWeek'] || '',
                'Start Date': program['First Date'] || '',
                'End Date': program['Last Date'] || '',
                Source: 'city'
            };
        });

        // Step 3b: External sources (Canlan York, Moss Park, …)
        const external = await fetchExternalSources();
        const externalPrograms = Object.values(external).flatMap(s => s.records);
        const allPrograms = enrichedPrograms.concat(externalPrograms);

        // Step 3c: Rink inventory (indoor + outdoor pads, coordinates)
        console.log('\n🏟️ Building rink inventory...');
        let rinks = [];
        let rinksOk = true;
        try {
            rinks = await fetchRinkInventory();
            console.log(`   ✅ ${rinks.length} rink locations`);
        } catch (e) {
            rinksOk = false;
            console.warn(`   ⚠️ rink inventory failed: ${e.message} — keeping previous rinks.json`);
        }

        // Step 3d: Service alerts snapshot
        let alertsInfo = { changed: false, count: 0 };
        try {
            alertsInfo = await fetchAlerts();
        } catch (e) {
            console.warn(`   ⚠️ alerts fetch failed: ${e.message} — keeping previous alerts.json`);
        }

        // Step 4: Save files
        console.log('\n💾 Saving data files...');

        const metadata = {
            lastUpdated: new Date().toISOString(),
            source: 'City of Toronto Open Data + external venues',
            packageId: PACKAGE_ID,
            counts: {
                skatingPrograms: allPrograms.length,
                cityPrograms: enrichedPrograms.length,
                locations: datasets.locations?.length || 0,
                rinks: rinks.length,
                alerts: alertsInfo.count
            },
            sources: Object.fromEntries(Object.entries(external).map(([k, v]) =>
                [k, { ok: v.ok, count: v.records.length, ...(v.error ? { error: v.error } : {}) }]))
        };

        // Save skating programs (the main file we need) — compact JSON:
        // pretty-printing costs ~2.5MB for zero benefit, GH Pages gzips it anyway
        const skatingFile = path.join(OUTPUT_DIR, 'skating-programs.json');
        fs.writeFileSync(skatingFile, JSON.stringify({
            metadata,
            programs: allPrograms
        }));
        console.log(`   ✅ ${skatingFile} (${(fs.statSync(skatingFile).size / 1024).toFixed(1)} KB)`);

        // Rink inventory for the locator / alert matching
        if (rinksOk) {
            const rinksFile = path.join(OUTPUT_DIR, 'rinks.json');
            fs.writeFileSync(rinksFile, JSON.stringify({
                metadata: { lastUpdated: metadata.lastUpdated, type: 'rinks' },
                rinks
            }));
            console.log(`   ✅ ${rinksFile} (${(fs.statSync(rinksFile).size / 1024).toFixed(1)} KB)`);
        }

        // Tiny meta.json so the client can check data freshness without
        // downloading the whole dataset (used by the 🔄 refresh button)
        const metaFile = path.join(OUTPUT_DIR, 'meta.json');
        fs.writeFileSync(metaFile, JSON.stringify(metadata));
        console.log(`   ✅ ${metaFile}`);

        // (locations.json / facilities.json are no longer written — the UI
        //  never loaded them; program records carry the joined location
        //  fields and rinks.json covers the locator. The city locations
        //  dataset is still FETCHED above because the program join needs it.)

        console.log('\n✨ Done! Data files are ready in:', OUTPUT_DIR);
        console.log('\nNext steps:');
        console.log('1. Deploy these JSON files with your site');
        console.log('2. The skate app loads from these local files');
        console.log('3. CI re-runs this weekly (and --alerts-only every ~30 min)\n');

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    }
}

main();
