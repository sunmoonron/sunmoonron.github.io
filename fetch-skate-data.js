#!/usr/bin/env node
/**
 * Data Fetcher Script - Downloads City of Toronto Recreation Data
 * plus external rink sources (Canlan York, Moss Park Arena), the city
 * rink inventory (indoor + outdoor pads → rinks.json) and live skate
 * service alerts (→ alerts.json).
 *
 * Usage:
 *   node fetch-skate-data.js                # full refresh (programs + rinks + alerts + live check)
 *   node fetch-skate-data.js --alerts-only  # light pass: alerts.json + live-check.json (cheap, run often)
 *
 * toronto.ca live endpoints send no Access-Control-Allow-Origin header,
 * so the browser can never fetch them directly — CI snapshots them here.
 *
 * LIVE CHECK (v3.1, the Malvern lesson): the City's open-data drop-in
 * export is refreshed WEEKLY and lags the live registration system — on
 * 2026-09-14 it still listed "Leisure Skate: Adult" at Malvern five times
 * that week while toronto.ca's own facility page listed none (a visitor
 * travelled there for nothing). toronto.ca renders its facility pages
 * from per-location week feeds (/data/parks/live/locations/<id>/skate/
 * weekN.json). fetchLiveCheck() cross-checks every city session in the
 * next two weeks against those feeds and writes live-check.json: sessions
 * the City no longer lists are flagged "missing", cancelled ones carry
 * the City's comment, and live-only sessions the export lacks are listed
 * as "extra". The client treats missing/cancelled like a closure alert.
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
    'canlan-etobicoke': {
        kind: 'daysmart',
        company: 'canlan',
        // Rinks 1-4 at CWENCH Centre (Etobicoke) — facility_id 3.
        resourceIds: [207, 208, 209, 210],
        daysAhead: 28,
        programs: [
            { match: /public\s*skat/i, activity: 'Public Skate', defaultPrice: 5 }
        ],
        locationName: 'CWENCH Centre (Canlan Etobicoke)',
        address: '1120 Martin Grove Rd',
        district: 'Etobicoke',
        postalCode: 'M9W 4W1',
        lat: 43.7002961, lng: -79.5750312,
        paid: true,
        registrationUrl: (date) => `https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?date=${date}&facility_ids=3&program_types=51`,
        infoUrl: 'https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?facility_ids=3&program_types=51'
    },
    'canlan-scarborough': {
        kind: 'daysmart',
        company: 'canlan',
        // Rinks 1-4 at Canlan Sports Scarborough — facility_id 15. Most
        // public skates here have an EMPTY event `desc`; the name only
        // lives in the summary / home-team name (fetchDaySmart falls back).
        resourceIds: [440, 441, 442, 443],
        daysAhead: 28,
        programs: [
            { match: /public\s*skat/i, activity: 'Public Skate', defaultPrice: 5 }
        ],
        locationName: 'Canlan Sports Scarborough',
        address: '159 Dynamic Dr',
        district: 'Scarborough',
        postalCode: 'M1V 5L8',
        lat: 43.8284798, lng: -79.2524897,   // Nominatim; DaySmart's own coordinate is 12.8 km off
        paid: true,
        registrationUrl: (date) => `https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?date=${date}&facility_ids=15&program_types=51`,
        infoUrl: 'https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?facility_ids=15&program_types=51'
    },
    'canlan-oakville': {
        kind: 'daysmart',
        company: 'canlan',
        // Rinks 1-4 at Entripy Centre (Oakville) — facility_id 13.
        // Busiest Canlan calendar (~290 events / 28 days): fetchDaySmart
        // filters to the Drop-In event type and pages at 500.
        resourceIds: [102, 103, 104, 105],
        daysAhead: 28,
        programs: [
            { match: /public\s*skat/i, activity: 'Public Skate', defaultPrice: 5 },
            // 55+ drop-in; DaySmart lists the product at $0.00
            { match: /senior\s*skat/i, activity: 'Senior Skate (55+)', defaultPrice: 0 }
        ],
        locationName: 'Entripy Centre (Canlan Oakville)',
        address: '2300 Cornwall Rd',
        district: 'Oakville',
        postalCode: 'L6J 7T9',
        lat: 43.4882179, lng: -79.6501451,
        paid: true,
        registrationUrl: (date) => `https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?date=${date}&facility_ids=13&program_types=51`,
        infoUrl: 'https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?facility_ids=13&program_types=51'
    },
    'canlan-oshawa': {
        kind: 'daysmart',
        company: 'canlan',
        // Rinks 1-2 at Canlan Sports Oshawa — facility_id 14. No public
        // skate published as of Sep 2026 (Stick & Puck / shinny only) —
        // yields 0 records until they add one; harmless.
        resourceIds: [54, 65],
        daysAhead: 28,
        programs: [
            { match: /public\s*skat/i, activity: 'Public Skate', defaultPrice: 5 }
        ],
        locationName: 'Canlan Sports Oshawa',
        address: '1401 Phillip Murray Ave',
        district: 'Oshawa',
        postalCode: 'L1J 8C4',
        lat: 43.8546816, lng: -78.8809418,
        paid: true,
        registrationUrl: (date) => `https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?date=${date}&facility_ids=14&program_types=51`,
        infoUrl: 'https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?facility_ids=14&program_types=51'
    },
    'markham': {
        kind: 'perfectmind',
        // City of Markham drop-in skating — official PerfectMind booking
        // API (the same JSON their booking page loads). One calendar
        // covers all skating drop-ins city-wide; each record names its
        // venue in `Location`, so one source can serve many buildings.
        base: 'https://cityofmarkham.perfectmind.com',
        widgetId: '6825ea71-e5b7-4c2a-948f-9195507ad90a',
        calendarId: 'ecf5202d-4c97-4f89-b4e3-42966a1cc453',
        daysAhead: 28,
        paid: true,
        // Venue coordinates/addresses (PerfectMind doesn't return them).
        // Unlisted venues still get records — just no locator distance
        // until someone adds a line here.
        venues: {
            'Angus Glen Community Centre': {
                address: '3990 Major Mackenzie Dr E', district: 'Markham',
                postalCode: 'L6C 1P8', lat: 43.904173, lng: -79.308765
            }
        },
        defaultDistrict: 'Markham',
        registrationUrl: () => 'https://cityofmarkham.perfectmind.com/Clients/BookMe4BookingPages/Classes?calendarId=ecf5202d-4c97-4f89-b4e3-42966a1cc453&widgetId=6825ea71-e5b7-4c2a-948f-9195507ad90a&embed=False',
        infoUrl: 'https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/programs/drop-programs'
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
// Per-location live feeds behind toronto.ca's facility pages (UTF-16 JSON!)
const LIVE_LOCATIONS_URL = 'https://www.toronto.ca/data/parks/live/locations/';
const LIVE_CHECK_DAYS = 14;          // this week + next (weekN.json files are Monday-based)
const LIVE_REQUEST_GAP_MS = 80;      // be a polite guest on toronto.ca

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
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(decodeBody(Buffer.concat(chunks))));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(45000, () => req.destroy(new Error(`Timeout for ${url.substring(0, 90)}`)));
    });
}

/**
 * Bytes → string, honouring a BOM. toronto.ca's per-location live feeds
 * are served as UTF-16LE with a BOM (JSON.parse chokes on them as UTF-8);
 * everything else is plain UTF-8.
 */
function decodeBody(buf) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
    return buf.toString('utf8');
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

/** POST form-encoded → JSON (PerfectMind-style widget endpoints). */
function httpPostJSON(url, formBody, headers = {}) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(formBody).toString();
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'User-Agent': 'toronto-skating-site-data-fetcher',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Length': Buffer.byteLength(body),
                ...headers
            }
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for POST ${url.substring(0, 80)}`));
            }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Failed to parse JSON: ${e.message}`)); }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(45000, () => req.destroy(new Error(`Timeout for POST ${url.substring(0, 80)}`)));
        req.write(body);
        req.end();
    });
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
        // Multi-venue sources (PerfectMind calendars) emit ONE entry per
        // configured venue, keyed like the program records' ExtLocationKey.
        if (cfg.venues) {
            Object.entries(cfg.venues).forEach(([name, v]) => {
                const locId = venueKey(key, name);
                byLocation[locId] = {
                    locationid: locId,
                    name,
                    address: v.address || '',
                    postal: v.postalCode || '',
                    district: v.district || cfg.defaultDistrict || '',
                    lat: v.lat ?? null, lng: v.lng ?? null,
                    kinds: ['indoor'],
                    pads: 1,
                    operator: 'External',
                    source: 'external',
                    externalSource: key,
                    website: cfg.infoUrl,
                    paid: !!cfg.paid
                };
            });
            return;
        }

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

/* ================= Live schedule cross-check → live-check.json ================= */

/** 'leisureskateadultunsupervised' — the only thing two feeds reliably agree on. */
function normTitle(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

/** "06:45 PM - 07:30 PM" → ['18:45', '19:30'] (null if unparseable). */
function parseLiveTimeRange(s) {
    const m = /(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(s || ''));
    if (!m) return null;
    return [to24h(m[1], m[2], m[3], false), to24h(m[4], m[5], m[6], false)];
}

const LIVE_WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Token-overlap similarity for "did the City just rename it?" (0..1). */
function titleSimilarity(a, b) {
    const ta = new Set(String(a).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const tb = new Set(String(b).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    if (!ta.size || !tb.size) return 0;
    let hit = 0;
    ta.forEach(t => { if (tb.has(t)) hit++; });
    return hit / Math.max(ta.size, tb.size);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Pull one location's live skate schedule for the weeks covering [from, to].
 * Returns { ok, entries: [{date,start,end,title,age,status,comment}], weeks }
 * — `ok:false` means the feed couldn't be read (never flag on silence).
 */
async function fetchLiveLocation(locId, from, to) {
    const base = `${LIVE_LOCATIONS_URL}${locId}/skate/`;
    let info;
    try {
        info = JSON.parse(await httpGetText(`${base}info.json`));
    } catch (e) {
        return { ok: false, error: `info.json: ${e.message}`, entries: [], weeks: 0 };
    }
    const weeks = (info && Array.isArray(info.weeks)) ? info.weeks : [];
    // A location with no skate section at all is a legitimate "no programs" answer
    if (!weeks.length) return { ok: true, entries: [], weeks: 0, noSection: true };

    const entries = [];
    let weeksRead = 0;
    for (const w of weeks) {
        const monday = String(w.title || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(monday)) continue;
        const sunday = addDays(monday, 6);
        if (sunday < from || monday > to) continue;            // week outside our window
        if (String(w.hasPrograms) === 'false') { weeksRead++; continue; }   // City: nothing that week
        await sleep(LIVE_REQUEST_GAP_MS);
        let week;
        try {
            week = JSON.parse(await httpGetText(`${base}${w.json || `week${w.id}.json`}`));
        } catch (e) {
            return { ok: false, error: `${w.json}: ${e.message}`, entries, weeks: weeksRead };
        }
        weeksRead++;
        (week.programs || []).forEach(prog => {
            (prog.days || []).forEach(d => {
                (d.times || []).forEach(t => {
                    const dayIdx = LIVE_WEEKDAYS.indexOf(String(t.day || d.day || '').toLowerCase());
                    const range = parseLiveTimeRange(t.title);
                    if (dayIdx < 0 || !range) return;
                    entries.push({
                        date: addDays(monday, dayIdx),
                        start: range[0], end: range[1],
                        title: String(d.title || '').trim(),
                        age: String(d.age || '').trim(),
                        status: String(t.status || d.status || 'active').toLowerCase(),
                        comment: String(t.comment || d.comment || '').trim()
                    });
                });
            });
        });
    }
    return { ok: true, entries, weeks: weeksRead };
}

/**
 * Cross-check city sessions (next LIVE_CHECK_DAYS days) against toronto.ca's
 * live per-location schedules. Writes live-check.json:
 *   flags: { "<LocationID>|<date>|<start>|<normTitle>": { s:'missing'|'cancelled', t:title, n:note } }
 *   extra: live sessions the open-data export doesn't have (informational)
 * Never flags on silence: a location whose feed failed is skipped, not flagged.
 * Returns { changed, stats }.
 */
async function fetchLiveCheck(programs) {
    console.log('\n🔎 Cross-checking city sessions against toronto.ca live schedules...');
    const today = torontoDateStr();
    const to = addDays(today, LIVE_CHECK_DAYS - 1);
    const nowHHMM = new Intl.DateTimeFormat('en-CA', { timeZone: TORONTO_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());

    // city sessions in the window, grouped by location
    const byLoc = {};
    (programs || []).forEach(p => {
        if (p.Source && p.Source !== 'city') return;
        const locId = p['Location ID'];
        const date = p['Start Date'] || '';
        if (locId == null || !date || date < today || date > to) return;
        (byLoc[String(locId)] ||= []).push(p);
    });
    const locIds = Object.keys(byLoc).sort((a, b) => a - b);
    console.log(`   ${locIds.length} locations, ${Object.values(byLoc).reduce((n, l) => n + l.length, 0)} sessions in ${today} → ${to}`);

    const flags = {};
    const extra = [];
    const stats = { locations: locIds.length, checked: 0, failed: 0, ok: 0, missing: 0, cancelled: 0, extra: 0 };
    const failedLocs = [];

    for (const locId of locIds) {
        await sleep(LIVE_REQUEST_GAP_MS);
        const live = await fetchLiveLocation(locId, today, to);
        if (!live.ok) {
            stats.failed++;
            failedLocs.push(`${locId} (${live.error})`);
            continue;
        }
        stats.checked++;
        const ours = byLoc[locId];
        if (live.noSection) {
            // toronto.ca has no Skating tab for this location at all — could be
            // a feed quirk as easily as a cancellation, so count, don't flag.
            stats.unverified = (stats.unverified || 0) + ours.length;
            continue;
        }
        const matched = new Set();   // indexes into live.entries that matched one of ours

        ours.forEach(p => {
            const date = p['Start Date'], start = p['Start Time'], end = p['End Time'];
            const title = p['Course Title'] || p.Activity || '';
            // Sessions already over today are irrelevant to travellers and the
            // City may prune them from the current week feed — never judge them.
            if (date === today && end && end <= nowHHMM) return;
            const key = `${locId}|${date}|${start}|${normTitle(title)}`;
            // exact (date, start, title) → the City still lists it
            let idx = live.entries.findIndex((e, i) => !matched.has(i) && e.date === date && e.start === start && normTitle(e.title) === normTitle(title));
            // same slot, renamed program (token overlap) → still counts as listed
            if (idx < 0) idx = live.entries.findIndex((e, i) => !matched.has(i) && e.date === date && e.start === start && e.end === end && titleSimilarity(e.title, title) >= 0.6);
            if (idx < 0) {
                // Missing on toronto.ca (its week feeds for this window were
                // read successfully — a failed feed returns early above).
                flags[key] = { s: 'missing', t: title };
                stats.missing++;
                return;
            }
            matched.add(idx);
            const e = live.entries[idx];
            if (e.status && e.status !== 'active') {
                flags[key] = { s: 'cancelled', t: title, n: e.comment || e.status };
                stats.cancelled++;
            } else {
                stats.ok++;
            }
        });

        // Live-only sessions (export lags additions too) — informational
        live.entries.forEach((e, i) => {
            if (matched.has(i)) return;
            if (e.date < today || e.date > to) return;
            if (e.date === today && e.end && e.end <= nowHHMM) return;   // already over
            extra.push({ LocationID: Number(locId), date: e.date, start: e.start, end: e.end, title: e.title, age: e.age, status: e.status, comment: e.comment });
            stats.extra++;
        });
    }
    if (failedLocs.length) console.warn(`   ⚠️ live feed unreadable for ${failedLocs.length} location(s): ${failedLocs.slice(0, 5).join('; ')}${failedLocs.length > 5 ? '…' : ''}`);
    const flagged = Object.entries(flags);
    if (flagged.length) console.log(`   🚫 ${flagged.length} flagged: ${flagged.slice(0, 8).map(([k, v]) => `${k.split('|').slice(0, 3).join(' ')} ${v.t} (${v.s})`).join(' • ')}${flagged.length > 8 ? ' …' : ''}`);
    console.log(`   ✅ live check: ${stats.checked}/${stats.locations} locations read, ${stats.ok} ok, ${stats.missing} missing, ${stats.cancelled} cancelled, ${stats.extra} live-only`);

    // Refuse to publish an all-failed run (toronto.ca down ≠ every rink closed)
    if (stats.locations && !stats.checked) {
        console.warn('   ⚠️ every live feed failed — keeping the previous live-check.json');
        return { changed: false, stats };
    }

    const file = path.join(OUTPUT_DIR, 'live-check.json');
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const now = new Date().toISOString();
    const body = { flags, extra, window: { from: today, to }, stats };
    const changed = !previous || JSON.stringify({ f: previous.flags, e: previous.extra, w: previous.window }) !== JSON.stringify({ f: flags, e: extra, w: body.window });
    const lastChecked = previous?.checkedAt;
    const heartbeatDue = !lastChecked || (Date.now() - new Date(lastChecked).getTime()) > 2 * 3600 * 1000;
    if (changed || heartbeatDue) {
        fs.writeFileSync(file, JSON.stringify({
            changedAt: changed ? now : (previous?.changedAt || now),
            checkedAt: now,
            source: 'toronto.ca live location schedules (data/parks/live/locations)',
            ...body
        }));
        console.log(changed ? '   ✅ live-check.json updated' : '   💓 live-check heartbeat stamped (unchanged)');
    } else {
        console.log('   ⏸  live-check unchanged — file not rewritten');
    }
    return { changed: changed || heartbeatDue, stats };
}

/* ================= External source fetchers ================= */

/** Shared shape for generated program records (mirrors the city schema). */
/**
 * `venue` (optional) overrides the cfg-level location for multi-venue
 * sources (PerfectMind calendars span several buildings): { name,
 * address, district, postalCode, lat, lng, extKey }. extKey becomes
 * ExtLocationKey — the client's locKey uses it so two Markham venues
 * don't collapse into one "location" in scopes/locator/map.
 */
function externalRecord(cfg, sourceKey, { activity, date, startTime, endTime, price, externalId, venue, ageMin, ageMax }) {
    const v = venue || {};
    return {
        _id: `${sourceKey}-${externalId || `${date}-${startTime}`}`,
        'Location ID': cfg.locationId || null,
        'Course Title': activity,
        Section: 'Skating - Drop-In',
        Activity: activity,
        Category: 'Skating - Drop-In',
        LocationName: v.name || cfg.locationName,
        LocationType: 'arena',
        Address: v.address ?? cfg.address ?? '',
        District: v.district ?? cfg.district ?? '',
        PostalCode: v.postalCode ?? cfg.postalCode ?? '',
        Accessibility: '', TTCInfo: '', Intersection: '',
        'Age Min': ageMin ?? null,
        'Age Max': ageMax ?? null,
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
        ...(v.extKey ? { ExtLocationKey: v.extKey } : {}),
        Paid: !!cfg.paid,
        Price: cfg.paid ? (price ?? null) : 0,
        RegistrationUrl: cfg.registrationUrl ? cfg.registrationUrl(date) : (cfg.infoUrl || ''),
        InfoUrl: cfg.infoUrl || '',
        Unverified: !!cfg.unverified,
        Lat: v.lat ?? cfg.lat, Lng: v.lng ?? cfg.lng
    };
}

/** Stable per-venue key for multi-venue sources: 'ext-markham-angus-glen-…'. */
function venueKey(sourceKey, venueName) {
    return `ext-${sourceKey}-${String(venueName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/** DaySmart Recreation (Canlan): published events on the configured rinks. */
async function fetchDaySmart(sourceKey, cfg) {
    const start = torontoDateStr();
    const end = addDays(start, cfg.daysAhead);
    // event_type_id 56 = "Drop-In" (verified 2026-09-14) keeps busy rinks
    // (Oakville: ~290 events/month incl. leagues) under one page of 500,
    // which their API honours (`page[size]` up to 1000; no pagination here).
    const url = `https://api.daysmartrecreation.com/v1/events?cache%5Bsave%5D=false` +
        `&filter%5Bresource_id__in%5D=${cfg.resourceIds.join(',')}` +
        `&filter%5Bevent_type_id%5D=56` +
        `&filter%5Bstart_date__gte%5D=${start}&filter%5Bstart_date__lte%5D=${end}` +
        `&filter%5Bpublish%5D=1&page%5Bsize%5D=500&sort=start` +
        `&include=homeTeam.product,summary&company=${cfg.company}`;
    const json = await fetchJSON(url, { Accept: 'application/vnd.api+json' });
    if (json.links?.next) console.warn(`   ⚠️ ${sourceKey}: more than one page of events — later sessions missing this run`);

    // team id → product price (the $ shown on their registration page)
    const teams = {}, products = {}, summaries = {};
    (json.included || []).forEach(i => {
        if (i.type === 'teams') teams[i.id] = i.attributes;
        if (i.type === 'products') products[i.id] = i.attributes;
        if (i.type === 'event-summaries') summaries[i.id] = i.attributes;
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
        // Scarborough publishes public skates with an EMPTY desc — the
        // name then lives only in the summary / home-team record.
        const label = (a.desc || '').trim() || summaries[e.id]?.name || teams[a.hteam_id]?.name || '';
        const rule = cfg.programs.find(r => r.match.test(label));
        if (!rule) return;
        // `start`/`end` are facility-local (America/Toronto) naive timestamps
        const date = String(a.start).slice(0, 10);
        const startTime = String(a.start).slice(11, 16);
        const endTime = String(a.end).slice(11, 16);
        if (!date || !startTime) return;
        records.push(externalRecord(cfg, sourceKey, {
            activity: rule.activity || label.trim(),
            date, startTime, endTime,
            price: priceForTeam(a.hteam_id) ?? rule.defaultPrice ?? null,
            externalId: e.id
        }));
    });
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions (${start} → ${end})`);
    return records;
}

/**
 * PerfectMind (Markham etc.): the official JSON the city's booking page
 * loads. One POST returns ~a month of drop-in classes across all venues
 * on the calendar. Not paginated here on purpose: the response already
 * spans our daysAhead window; if the feed ever shrinks below it, the
 * nextKey warning in the log says so.
 */
async function fetchPerfectMind(sourceKey, cfg) {
    const today = torontoDateStr();
    const end = addDays(today, cfg.daysAhead);
    const json = await httpPostJSON(`${cfg.base}/Clients/BookMe4BookingPagesV2/ClassesV2`, {
        calendarId: cfg.calendarId,
        widgetId: cfg.widgetId,
        page: 0
    });
    const classes = json.classes || [];
    if (json.nextKey && String(json.nextKey) < end) {
        console.warn(`   ⚠️ ${sourceKey}: feed ends ${json.nextKey}, window wants ${end} — later sessions missing this run`);
    }

    const timeRe = /(\d{1,2}):(\d{2})\s*(am|pm)\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)/i;
    const unknownVenues = new Set();
    const records = [];
    classes.forEach(c => {
        const od = String(c.OccurrenceDate || '');
        if (!/^\d{8}$/.test(od)) return;
        const date = `${od.slice(0, 4)}-${od.slice(4, 6)}-${od.slice(6, 8)}`;
        if (date < today || date > end) return;

        const t = timeRe.exec(c.EventTimeDescription || '');
        if (!t) return;
        const startTime = to24h(t[1], t[2], t[3], false);
        const endTime = to24h(t[4], t[5], t[6], false);
        if (!startTime || !endTime) return;

        // "$0.00 - $5.02" → 5.02 (max = standard adult rate; 0 = free tiers)
        const prices = [...String(c.PriceRange || '').matchAll(/\$([\d.]+)/g)].map(m => parseFloat(m[1]));
        const price = prices.length ? Math.max(...prices) : null;

        const venueName = c.Location || cfg.locationName || 'Markham venue';
        const known = (cfg.venues || {})[venueName];
        if (!known) unknownVenues.add(venueName);

        records.push(externalRecord(cfg, sourceKey, {
            activity: String(c.EventName || 'Drop-In Skate').trim(),
            date, startTime, endTime, price,
            externalId: `${c.EventId || c.CourseIdTrimmed || 'x'}-${od}`,
            ageMin: c.NoAgeRestriction ? null : (Number.isFinite(c.MinAge) && c.MinAge > 0 ? c.MinAge : null),
            ageMax: c.NoAgeRestriction ? null : (Number.isFinite(c.MaxAge) && c.MaxAge > 0 && c.MaxAge < 120 ? c.MaxAge : null),
            venue: { name: venueName, ...(known || {}), extKey: venueKey(sourceKey, venueName) }
        }));
    });
    if (unknownVenues.size) {
        console.warn(`   📍 ${sourceKey}: venues without coords in config (add to venues{}): ${[...unknownVenues].join(', ')}`);
    }
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions (${today} → ${end})`);
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
            const fetcher = { daysmart: fetchDaySmart, perfectmind: fetchPerfectMind, scrape: fetchScraped }[cfg.kind];
            if (!fetcher) throw new Error(`unknown source kind '${cfg.kind}'`);
            bySource[key] = { ok: true, records: await fetcher(key, cfg) };
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
            try {
                const prev = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'skating-programs.json'), 'utf8'));
                await fetchLiveCheck(prev.programs || []);
            } catch (e) {
                console.warn(`   ⚠️ live check skipped: ${e.message}`);
            }
            console.log('\n✨ Light pass (alerts + live check) complete.');
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

        // Step 5: cross-check the fresh city rows against toronto.ca's live
        // per-location schedules (the export lags the live system by days)
        try {
            await fetchLiveCheck(allPrograms);
        } catch (e) {
            console.warn(`   ⚠️ live check failed: ${e.message} — keeping previous live-check.json`);
        }

        // (locations.json / facilities.json are no longer written — the UI
        //  never loaded them; program records carry the joined location
        //  fields and rinks.json covers the locator. The city locations
        //  dataset is still FETCHED above because the program join needs it.)

        console.log('\n✨ Done! Data files are ready in:', OUTPUT_DIR);
        console.log('\nNext steps:');
        console.log('1. Deploy these JSON files with your site');
        console.log('2. The skate app loads from these local files');
        console.log('3. CI re-runs this weekly (and the light alerts + live-check pass every ~15 min)\n');

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    }
}

main();
