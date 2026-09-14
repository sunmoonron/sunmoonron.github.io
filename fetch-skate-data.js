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
// Dev: `--only=stouffville,ajax` runs just those external sources and writes nothing.
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').map(s => s.trim()).filter(Boolean);

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
        // PriceRange's max is the FAMILY ticket for skates ($13.45); the adult
        // drop-in is $5.02 + HST. Shinny/stick-and-puck ranges top out at the
        // adult tier already, so only skates get the override.
        priceRules: [{ match: /skate/i, price: 5.17 }],
        // Names must equal PerfectMind's `Location` string exactly. Coords =
        // the feed's own Address block, Nominatim-checked (the old hand-typed
        // Angus Glen point was 2.4 km off). Unlisted venues are learned from
        // the feed at run time.
        venues: {
            'Angus Glen Community Centre':      { address: '3990 Major Mackenzie Dr E', district: 'Markham', postalCode: 'L6C 1P8', lat: 43.895354, lng: -79.336539 },
            'Crosby Community Centre':          { address: '210 Main St Unionville',     district: 'Markham', postalCode: 'L3R 2G9', lat: 43.868535, lng: -79.313304 },
            'Milliken Mills Community Centre':  { address: '7600 Kennedy Rd',            district: 'Markham', postalCode: 'L3R 9S5', lat: 43.840228, lng: -79.305006 },
            'Thornhill Community Centre':       { address: '7755 Bayview Ave',           district: 'Markham', postalCode: 'L3T 4P1', lat: 43.820032, lng: -79.399873 },
            'Markham Village Community Centre': { address: '6041 Highway 7',             district: 'Markham', postalCode: 'L3P 3A7', lat: 43.873298, lng: -79.258153 },
            'Mount Joy Community Centre':       { address: '6140 16th Ave E',            district: 'Markham', postalCode: 'L3P 3K8', lat: 43.895012, lng: -79.262293 }
        },
        defaultDistrict: 'Markham',
        registrationUrl: () => 'https://cityofmarkham.perfectmind.com/Clients/BookMe4BookingPages/Classes?calendarId=ecf5202d-4c97-4f89-b4e3-42966a1cc453&widgetId=6825ea71-e5b7-4c2a-948f-9195507ad90a&embed=False',
        infoUrl: 'https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/programs/drop-programs'
    },
    'vaughan': {
        kind: 'perfectmind',
        // City of Vaughan — PerfectMind org 25076, calendar "Skating & Shinny
        // Hockey". Drop-in skating and shinny are FREE ("No fee" → $0, so
        // rows aren't hidden behind the Paid toggle); Ticket Ice figure
        // skating is $10.50 and keeps its own price. ~85 sessions/week →
        // 3-day windows stay under the ClassesV2 truncation.
        base: 'https://vaughan.perfectmind.com/25076',
        widgetId: 'dff88c8a-0b78-4a94-9dde-250040385300',
        calendarId: '84142d20-1da8-48ed-800d-31dc0c30121d',
        daysAhead: 28,
        windowDays: 3,
        paid: true,
        // The booking page lists every tier as "Free", but that is the resident
        // rate; non-residents pay at the desk. Say so on every free row.
        priceNote: (price) => price === 0 ? 'Free for Vaughan residents · non-residents: ask at the desk (city fees carry a 20% non-resident surcharge)' : '',
        venues: {
            'Al Palladini Community Centre':       { address: '9201 Islington Ave',      district: 'Vaughan', postalCode: 'L4L 1A7', lat: 43.816528,  lng: -79.597205 },
            'Rosemount Community Centre':          { address: '1000 New Westminster Dr', district: 'Vaughan', postalCode: 'L4J 8G3', lat: 43.817858,  lng: -79.453424 },
            'Garnet A. Williams Community Centre': { address: '501 Clark Ave W',         district: 'Vaughan', postalCode: 'L4J 4E5', lat: 43.803966,  lng: -79.439973 },
            'Woodbridge Pool & Memorial Arena':    { address: '5020 Highway 7',          district: 'Vaughan', postalCode: 'L4L 1T1', lat: 43.7802455, lng: -79.5916837 },
            'Maple Community Centre':              { address: '10190 Keele St',          district: 'Vaughan', postalCode: 'L6A 1R7', lat: 43.859882,  lng: -79.514834 }
        },
        defaultDistrict: 'Vaughan',
        registrationUrl: () => 'https://vaughan.perfectmind.com/25076/Clients/BookMe4BookingPages/Classes?calendarId=84142d20-1da8-48ed-800d-31dc0c30121d&widgetId=dff88c8a-0b78-4a94-9dde-250040385300&embed=False',
        infoUrl: 'https://www.vaughan.ca/residential/recreation-programs-and-fitness/skating-hockey'
    },
    'richmondhill': {
        kind: 'activenet',
        // City of Richmond Hill — ActiveNet online calendar 12 "Skating &
        // Shinny", which carries Ed Sackfield Arena only (the other arenas'
        // drop-ins exist as weekly activity patterns, not calendar rows —
        // not wired yet). The calendar period rolls ~3 weeks ahead.
        base: 'https://anc.ca.apm.activecommunities.com/richmondhill/rest',
        calendarId: 12,
        categoryIds: [],
        centerIds: [27],
        daysAhead: 28,
        paid: true,                     // tickets at the arena desk from 30 min before (not sold online)
        programs: [
            { match: /public skating/i,   activity: 'Public Skating',       defaultPrice: 5.90 },
            { match: /40\+.*shinny/i,      activity: 'Shinny 40+',           defaultPrice: 8.70, ageMin: 40 },
            { match: /shinny/i,           activity: 'Shinny',               defaultPrice: 8.70, ageMin: 18 },
            { match: /stick (and|&) puck/i, activity: 'Stick & Puck',       defaultPrice: 8.70 },
            { match: /figure skat/i,      activity: 'Figure Skating (drop-in)', defaultPrice: 8.70 },
            { match: /ringette/i,         activity: 'Ringette (drop-in)',   defaultPrice: 8.70 }
        ],
        venues: {
            'Ed Sackfield Arena and Fitness Centre': { address: '311 Valleymede Dr', district: 'Richmond Hill', postalCode: 'L4B 2E1', lat: 43.8571076, lng: -79.3989503 }
        },
        defaultDistrict: 'Richmond Hill',
        registrationUrl: () => 'https://www.richmondhill.ca/en/things-to-do/Skating.aspx',
        infoUrl: 'https://www.richmondhill.ca/en/things-to-do/Skating.aspx'
    },
    'brampton': {
        kind: 'perfectmind',
        // City of Brampton — PerfectMind org 23782, calendar "Drop-In → Skating".
        // Busiest calendar around (up to 32 sessions/day): 1-day windows keep
        // every request under the server's ~50-class truncation (see
        // fetchPerfectMind). Feed carries venue coordinates; venues{} below
        // is the rink-inventory list + override.
        base: 'https://cityofbrampton.perfectmind.com/23782',
        widgetId: '15f6af07-39c5-473e-b053-96653f77a406',
        calendarId: '66a6c983-2ead-42a9-8445-d926fa974fbf',
        daysAhead: 28,
        windowDays: 1,
        include: /public skate/i,                       // drop shinny / shoot-around / figure
        cleanName: (n) => n.replace(/\s*\|.*$/, ''),   // "Public Skate Drop-In (All Ages) | Susan Fennell 12:00-12:50pm"
        paid: true,                                     // adult $2.96 + tax; 65+ residents free
        venues: {
            'Cassie Campbell Community Centre':           { address: '1050 Sandalwood Pkwy W', district: 'Brampton', postalCode: 'L7A 0K9', lat: 43.696632, lng: -79.824842 },
            'Century Gardens Recreation Centre':          { address: '340 Vodden St E',        district: 'Brampton', postalCode: 'L6V 2N2', lat: 43.708429, lng: -79.753575 },
            'Earnscliffe Recreation Centre':              { address: '44 Eastbourne Dr',       district: 'Brampton', postalCode: 'L6T 2B2', lat: 43.723334, lng: -79.699493 },
            'Greenbriar Recreation Centre':               { address: '1100 Central Park Dr',   district: 'Brampton', postalCode: 'L6S 2C9', lat: 43.735986, lng: -79.717288 },
            'Jim Archdekin Recreation Centre':            { address: '292 Conestoga Dr',       district: 'Brampton', postalCode: 'L6Z 3M1', lat: 43.71733,  lng: -79.789659 },
            "Susan Fennell Sportsplex (South Fletcher's)": { address: '500 Ray Lawson Blvd',   district: 'Brampton', postalCode: 'L6Y 5B3', lat: 43.652793, lng: -79.735956 },
            'Terry Miller Recreation Centre':             { address: '1295 Williams Pkwy',     district: 'Brampton', postalCode: 'L6S 3J8', lat: 43.73265,  lng: -79.730347 }
        },
        defaultDistrict: 'Brampton',
        registrationUrl: () => 'https://cityofbrampton.perfectmind.com/23782/Clients/BookMe4BookingPages/Classes?calendarId=66a6c983-2ead-42a9-8445-d926fa974fbf&widgetId=15f6af07-39c5-473e-b053-96653f77a406&embed=False',
        infoUrl: 'https://www.brampton.ca/EN/residents/Recreation/Programs-Activities/Pages/Skating.aspx'
    },
    'oakville': {
        kind: 'perfectmind',
        // Town of Oakville — PerfectMind org 24974, calendar "Recreational
        // Skating and Shinny Hockey" (shinny filtered out by `include`).
        base: 'https://townofoakville.perfectmind.com/24974',
        widgetId: 'e621581b-5db2-4635-a887-4f02b9585807',
        calendarId: '332fd288-9a60-4b8f-9b7b-373c4e1bed5d',
        daysAhead: 28,
        windowDays: 7,
        include: /recreation(al)?\s+skat/i,
        paid: true,                                     // adult $5.38, child/youth/65+ $4.31 + tax
        venues: {
            'Glen Abbey Community Centre':     { address: '1415 Third Line',        district: 'Oakville', postalCode: 'L6M 3G2', lat: 43.435554, lng: -79.739041 },
            "Joshua's Creek Arenas":           { address: '1663 North Service Rd E', district: 'Oakville', postalCode: 'L6H 7G5', lat: 43.491731, lng: -79.676112 },
            'Kinoak Arena':                    { address: '363 Warminster Dr',      district: 'Oakville', postalCode: 'L6L 4N1', lat: 43.4198,   lng: -79.699932 },
            'Maple Grove Arena':               { address: '2237 Devon Rd',          district: 'Oakville', postalCode: 'L6J 5M1', lat: 43.479078, lng: -79.643756 },
            'River Oaks Community Centre':     { address: '2400 Sixth Line',        district: 'Oakville', postalCode: 'L6H 3N8', lat: 43.47104,  lng: -79.72358 },
            'Sixteen Mile Sports Complex':     { address: '3070 Neyagawa Blvd',     district: 'Oakville', postalCode: 'L6M 4L6', lat: 43.465913, lng: -79.749331 },
            'Trafalgar Park Community Centre': { address: '133 Rebecca St',         district: 'Oakville', postalCode: 'L6K 1J4', lat: 43.439878, lng: -79.677705 }
        },
        venueAliases: { 'Trafalgar Park Community Centre-133 Rebecca': 'Trafalgar Park Community Centre' },
        defaultDistrict: 'Oakville',
        registrationUrl: () => 'https://townofoakville.perfectmind.com/24974/Clients/BookMe4BookingPages/Classes?calendarId=332fd288-9a60-4b8f-9b7b-373c4e1bed5d&widgetId=e621581b-5db2-4635-a887-4f02b9585807&embed=False',
        infoUrl: 'https://www.oakville.ca/parks-recreation-culture/programs-activities/skating/'
    },
    'burlington': {
        kind: 'perfectmind',
        // City of Burlington — PerfectMind org 22818; one shared calendar
        // holds skating + sticks-and-pucks (filtered by `include`).
        base: 'https://cityofburlington.perfectmind.com/22818',
        widgetId: '8d8b4749-9c4e-4762-be93-fe54f1e1203b',
        calendarId: '517e0420-1478-458e-8a6f-ad813e278ec0',
        daysAhead: 28,
        windowDays: 3,
        include: /^(public skate|skate 19\+|sensory skate)/i,
        paid: true,                                     // flat $3.50 (pass holders $0)
        venues: {
            'Aldershot Arena':                { address: '494 Townsend Ave',     district: 'Burlington', postalCode: 'L7T 2B3', lat: 43.316465, lng: -79.833132 },
            'Appleby Ice Centre':             { address: '1201 Appleby Line',    district: 'Burlington', postalCode: 'L7S 1E4', lat: 43.38674,  lng: -79.775557 },
            'Central Arena':                  { address: '519 Drury Lane',       district: 'Burlington', postalCode: 'L7R 2H2', lat: 43.335167, lng: -79.792986 },
            'Mainway Ice Centre':             { address: '4015 Mainway',         district: 'Burlington', postalCode: 'L7P 3N9', lat: 43.372749, lng: -79.795877 },
            'Mountainside Community Centre':  { address: '2205 Mount Forest Dr', district: 'Burlington', postalCode: 'L7P 1H4', lat: 43.352526, lng: -79.822977 },
            'Nelson Arena':                   { address: '4235 New St',          district: 'Burlington', postalCode: 'L7L 5M9', lat: 43.360767, lng: -79.763181 },
            'Skyway Community Centre':        { address: '129 Kenwood Ave',      district: 'Burlington', postalCode: 'L7M 1V8', lat: 43.368761, lng: -79.733246 }
        },
        defaultDistrict: 'Burlington',
        registrationUrl: () => 'https://cityofburlington.perfectmind.com/22818/Clients/BookMe4BookingPages/Classes?calendarId=517e0420-1478-458e-8a6f-ad813e278ec0&widgetId=8d8b4749-9c4e-4762-be93-fe54f1e1203b&embed=False',
        infoUrl: 'https://www.burlington.ca/en/recreation/skating.aspx'
    },
    'mississauga': {
        kind: 'activenet',
        // City of Mississauga — ActiveNet online calendar (calendar 1 = "Drop
        // In Programs", category 52 = "Skating & Hockey"). One POST returns
        // every dated session for the whole season across the listed arenas;
        // the server ignores date bounds, so we window client-side. No CORS.
        base: 'https://anc.ca.apm.activecommunities.com/activemississauga/rest',
        calendarId: 1,
        categoryIds: [52],
        centerIds: [290, 248, 240, 250, 252, 253, 100, 82, 128, 106],
        daysAhead: 28,
        paid: true,
        // Prices aren't in the API (only a free flag) → 2026 by-law rates + HST.
        programs: [
            { match: /^At Play-?\s*Fun Skate$/i,      activity: 'Fun Skate (Youth 10–17, free)', defaultPrice: 0,     ageMin: 10, ageMax: 17 },
            { match: /^Fun Skate$/i,                   activity: 'Fun Skate',                      defaultPrice: 5.21,  ageMin: 3 },
            { match: /Adult & Older Adult Skate/i,     activity: 'Adult & Older Adult Skate',      defaultPrice: 5.21,  ageMin: 18 },
            { match: /Adult Skate Fit/i,               activity: 'Adult Skate Fit',                defaultPrice: 19.46, ageMin: 18 }
        ],
        venues: {
            'Burnhamthorpe Community Centre':       { address: '1500 Gulleden Dr',             district: 'Mississauga', postalCode: 'L4X 2T7', lat: 43.6227, lng: -79.5988 },
            'Carmen Corbasson Community Centre':    { address: '1399 Cawthra Rd',              district: 'Mississauga', postalCode: 'L5G 4L1', lat: 43.5782, lng: -79.5767 },
            'Clarkson Community Centre':            { address: '2475 Truscott Dr',             district: 'Mississauga', postalCode: 'L5J 2B3', lat: 43.5116, lng: -79.6503 },
            'Erin Mills Twin Arena':                { address: '3205 Unity Dr',                district: 'Mississauga', postalCode: 'L5L 4L5', lat: 43.5371, lng: -79.7116 },
            'Huron Park Recreation Centre':         { address: '830 Paisley Blvd W',           district: 'Mississauga', postalCode: 'L5C 3P5', lat: 43.5591, lng: -79.6331 },
            'Iceland Arena':                        { address: '705 Matheson Blvd E',          district: 'Mississauga', postalCode: 'L4Z 3X9', lat: 43.628,  lng: -79.6494 },
            'Meadowvale 4 Rinks':                   { address: '2160 Torquay Mews',            district: 'Mississauga', postalCode: 'L5N 2M6', lat: 43.5952, lng: -79.7409 },
            'Mississauga Valley Community Centre':  { address: '1275 Mississauga Valley Blvd', district: 'Mississauga', postalCode: 'L5A 3R8', lat: 43.597,  lng: -79.6239 },
            'Paul Coffey Arena':                    { address: '6990 Goreway Dr',              district: 'Mississauga', postalCode: 'L4T 1A9', lat: 43.7125, lng: -79.6311 },
            'Port Credit Memorial Arena':           { address: '40 Stavebank Rd',              district: 'Mississauga', postalCode: 'L5G 2T8', lat: 43.553,  lng: -79.589 }
        },
        defaultDistrict: 'Mississauga',
        // No per-session online booking (tickets sold 30 min before) — the
        // fetcher deep-links each event's own activity page instead.
        registrationUrl: () => 'https://anc.ca.apm.activecommunities.com/activemississauga/activity/search?activity_select_param=2&activity_keyword=skate',
        infoUrl: 'https://www.mississauga.ca/recreation-and-sports/sports-and-activities/skating-and-hockey/'
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
    },
    /* ---- York & Durham cities without an API (see skate/docs/data-sources/york-durham.md) ---- */
    'stouffville': {
        kind: 'pdf',
        layout: 'weekday-grid',
        // Whitchurch-Stouffville publishes its drop-in sheet as a PDF (grid:
        // Activity | Age | Monday … Sunday, one block per arena). The Town's
        // ActiveNet "Skating & Shinny" calendar (3) is checked first — it
        // was published empty for fall 2026 but is the better source if it
        // ever fills up. The PDF's path changes per revision → discovered
        // from the drop-in page each run; pdfUrl is only the fallback.
        activenet: { base: 'https://anc.ca.apm.activecommunities.com/townofws/rest', calendarId: 3, centerIds: [13, 14] },
        discover: {
            page: 'https://www.townofws.ca/play/recreation/programs/drop-in-programs/',
            hops: [/href="([^"]*\/media\/[^"]*skating-[^"]*dropin[^"]*\.pdf)"/i]
        },
        pdfUrl: 'https://www.townofws.ca/media/zkrbulbm/skating-f26_dropin_sep9.pdf',
        grid: { stopAt: /Important Information/i },
        daysAhead: 28,
        paid: true,
        // Adult drop-in fees incl. HST (fall 2026 sheet): skate $5.50, stick & puck / shinny $7.50.
        programs: [
            { match: /shinny|stick/i, price: 7.50 },
            { match: /./,             price: 5.50 }
        ],
        priceNote: 'Adult price at the door (15 min before) · youth & 60+ $3.50 / $5.50, tots $2.50 / $4.50, family $12.50 / $17.50',
        venues: {
            'Stouffville Clippers Sports Complex': { address: '120 Weldon Rd',     district: 'Stouffville', postalCode: 'L4A 1N2', lat: 43.9650556, lng: -79.2617345 },
            'Stouffville Arena':                   { address: '12483 Ninth Line', district: 'Stouffville', postalCode: 'L4A 1J3', lat: 43.9742243, lng: -79.2553137 }
        },
        district: 'Stouffville',
        unverified: true,      // PDF, no live feed — check before a long drive
        infoUrl: 'https://www.townofws.ca/play/recreation/programs/drop-in-programs/'
    },
    'ajax': {
        kind: 'pdf',
        layout: 'weekday-lines',
        // ajax.ca → Publitas flipbook → its PDF: three plain GETs. The
        // flipbook name embeds the season, so it is rediscovered each run.
        discover: {
            page: 'https://ajax.ca/explore/parks-recreation/sports-recreation/skating/',
            hops: [
                /(https:\/\/view\.publitas\.com\/ajax\/skating-schedule[^"'\s<>]*)/i,
                /(https:\/\/view\.publitas\.com\/\d+\/\d+\/pdfs\/[^"]+\.pdf[^"]*)/i
            ]
        },
        daysAhead: 28,
        paid: true,
        locationName: 'Ajax Community Centre',
        // Fall 2026 admissions: skating adult $5.25 (youth & 65+ $3.50), shinny/sledge adult $7.90 (youth & 65+ $5.65).
        programs: [
            { match: /ticket ice/i,                   skip: true },   // Skate Canada members with a coach only
            { match: /parent\s*(?:&|and)\s*tot/i,     activity: 'Parent & Tot Skate',   ageMax: 5,  price: 5.25 },
            { match: /public skat/i,                  activity: 'Public Skating',                    price: 5.25 },
            { match: /adult skate/i,                  activity: 'Adult Skate',          ageMin: 18, price: 5.25 },
            { match: /stick\s*(?:n|&|and)\s*puck/i,   activity: 'Adult Stick & Puck',   ageMin: 18, price: 5.25 },
            { match: /ladies shinny/i,                activity: 'Ladies Shinny',        ageMin: 18, price: 7.90 },
            { match: /sledge/i,                       activity: 'Sledge Shinny (adapted)',           price: 7.90 },
            { match: /shinny/i,                       activity: 'Adult Shinny',         ageMin: 18, price: 7.90 }
        ],
        priceNote: 'Adult price · youth & 65+ $3.50 (shinny $5.65) · 3 & under free · pay at the desk',
        venues: {
            'Ajax Community Centre': { address: '75 Centennial Rd', district: 'Ajax', postalCode: 'L1S 4L1', lat: 43.8393724, lng: -79.0206406 }
        },
        district: 'Ajax',
        unverified: true,
        infoUrl: 'https://ajax.ca/explore/parks-recreation/sports-recreation/skating/'
    },
    'oshawa': {
        kind: 'intelligenz',
        // "activeOshawa Online" (Intelligenz) behind a Queue-it gate: one
        // VenueClasses page per arena carries every dated session for the
        // window. Harman Park Arena (829 Douglas St, 43.8786429,
        // -78.8469186) had no fall ice sessions published yet — add its GUID
        // (first row's VenueClasses link on category SKATEHP) when it does.
        base: 'https://register.oshawa.ca/OSHAWA',
        daysAhead: 28,
        paid: true,
        activityMatch: /skate|shinny|stick|ticket ice/i,
        venues: {
            'Delpark Homes Centre':       { guid: '0c780b98-9e2c-4f79-a226-a6106d010224', address: '1661 Harmony Rd N', district: 'Oshawa', postalCode: 'L1H 7K5', lat: 43.9485033, lng: -78.8512963 },
            'Donevan Recreation Complex': { guid: '96bac799-82c0-45ed-b6ab-065a198d48a5', address: '171 Harmony Rd S',  district: 'Oshawa', postalCode: 'L1H 6T9', lat: 43.8999743, lng: -78.8305996 }
        },
        // 2026 admissions: leisure skate adult $5.25, shinny adult $8.50, figure/ticket ice $11.25.
        programs: [
            { match: /ticket ice/i, activity: 'Ticket Ice (figure skating practice)', price: 11.25 },
            { match: /shinny/i,     price: 8.50 },
            { match: /./,           price: 5.25 }
        ],
        priceNote: 'Adult price · child/youth/student $3.50, family $10.75, Oshawa 55+ $1.50 · shinny youth $6.50 · pay at the desk',
        district: 'Oshawa',
        registrationUrl: () => 'https://register.oshawa.ca/OSHAWA/public/category/browse/SKATEDHC',
        infoUrl: 'https://www.oshawa.ca/explore-play/recreation/hockey-and-skating/leisure-skating/'
    },
    'pickering': {
        kind: 'html-grid',
        // pickering.ca embeds the season's grids as plain tables (row =
        // weekday, column = program) with the season dates and cancellation
        // list in the text around them. Admission is free.
        url: 'https://www.pickering.ca/parks-recreation-culture/arenas-and-skating/',
        daysAhead: 28,
        paid: false,
        venues: {
            'Chestnut Hill Developments Recreation Complex': { address: '1867 Valley Farm Rd', district: 'Pickering', postalCode: 'L1V 3Y7', lat: 43.8392345, lng: -79.0814572 },
            'Don Beer Arena':                                { address: '940 Dillingham Rd',   district: 'Pickering', postalCode: 'L1W 1Z6', lat: 43.8246758, lng: -79.0671679 }
        },
        venueAliases: { 'CHD Rec Complex': 'Chestnut Hill Developments Recreation Complex', 'CHDRC': 'Chestnut Hill Developments Recreation Complex' },
        programs: [
            { match: /^daytime/i,             activity: 'Daytime Skate' },
            { match: /^public/i,              activity: 'Public Skate' },
            { match: /p\s*&\s*c stick/i,      activity: 'Parent & Child Stick & Puck' },
            { match: /p\s*&\s*c skate/i,      activity: 'Parent & Child Skate' }
        ],
        seasons: [
            { label: /Daytime Skating:/i,                      match: /daytime/i },
            { label: /Parent\s*&\s*Child\s*\/\s*Stick\s*&\s*Puck:/i, match: /parent & child/i },
            { label: /Public Skating:/i,                       match: /public skate/i }
        ],
        cancelGroups: [
            { label: /Public Skating:/i,   match: /public skate/i,   matchSample: 'Public Skate' },
            { label: /Daytime Skating:/i,  match: /daytime/i,        matchSample: 'Daytime Skate' },
            { label: /Parent\s*&\s*Child/i, match: /parent & child/i, matchSample: 'Parent & Child Skate' }
        ],
        district: 'Pickering',
        unverified: true,
        infoUrl: 'https://www.pickering.ca/parks-recreation-culture/arenas-and-skating/'
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

/** POST a JSON body → JSON (ActiveNet REST). */
function httpPostJSONBody(url, obj, headers = {}) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(obj);
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'User-Agent': 'toronto-skating-site-data-fetcher',
                'Content-Type': 'application/json;charset=UTF-8',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...headers
            }
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for POST ${url.substring(0, 80)}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(decodeBody(Buffer.concat(chunks)))); }
                catch (e) { reject(new Error(`Failed to parse JSON: ${e.message}`)); }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error(`Timeout for POST ${url.substring(0, 80)}`)));
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
            const all = { ...(discoveredVenues[key] || {}), ...cfg.venues };
            Object.entries(all).forEach(([name, v]) => {
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
function externalRecord(cfg, sourceKey, { activity, date, startTime, endTime, price, externalId, venue, ageMin, ageMax, registrationUrl }) {
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
        // A venue can charge in general yet run free sessions (Mississauga's
        // youth Fun Skate, Oakville's Senior Skate): an explicit $0 price
        // means "free", so the row isn't hidden behind the Paid toggle.
        Paid: !!cfg.paid && price !== 0,
        Price: (cfg.paid && price !== 0) ? (price ?? null) : 0,
        // Short honesty note shown beside the price ("free for residents…")
        PriceNote: typeof cfg.priceNote === 'function' ? (cfg.priceNote(price) || '') : (cfg.priceNote || ''),
        RegistrationUrl: registrationUrl || (cfg.registrationUrl ? cfg.registrationUrl(date) : (cfg.infoUrl || '')),
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
 * Venues learned from the PerfectMind feeds themselves (each class carries
 * Address {Street, City, PostalCode, Latitude, Longitude}). Filled by
 * fetchPerfectMind, read by fetchRinkInventory so unlisted venues still get
 * a pin and locator distance; cfg.venues stays the override.
 */
const discoveredVenues = {};   // sourceKey → { venueName → {address, postalCode, district, lat, lng} }

/**
 * PerfectMind (Markham, Brampton, Oakville, Burlington…): the official
 * JSON the city's booking page loads.
 *
 * ClassesV2 quirks (verified 2026-09-14 against four towns): `page=N` is
 * a 14-day window starting today+14N, every date parameter is ignored,
 * and a window is silently TRUNCATED after the first whole days that
 * reach ~50 classes — the next page then jumps 14 days ahead, so busy
 * calendars lose whole days (Brampton lost 20 of 28). The widget's Date
 * Range filter (values[0][valueKind]=6) returns complete windows, so we
 * walk the horizon in `windowDays` slices and, if a slice still comes
 * back suspiciously full, re-fetch it day by day.
 */
async function fetchPerfectMind(sourceKey, cfg) {
    const today = torontoDateStr();
    const end = addDays(today, cfg.daysAhead);
    const url = `${cfg.base}/Clients/BookMe4BookingPagesV2/ClassesV2`;
    const TRUNCATION_HINT = 48;   // the server cuts windows at ~50 classes
    const windowDays = Math.max(1, cfg.windowDays || 7);

    const fetchWindow = async (from, to) => {
        const json = await httpPostJSON(url, {
            calendarId: cfg.calendarId,
            widgetId: cfg.widgetId,
            page: 0,
            'values[0][value]': from,
            'values[0][value2]': to,
            'values[0][valueKind]': 6
        });
        return json.classes || [];
    };

    const classes = [];
    const seen = new Set();
    let requests = 0;
    for (let from = today; from <= end; from = addDays(from, windowDays)) {
        let to = addDays(from, windowDays - 1);
        if (to > end) to = end;
        let batch = await fetchWindow(from, to);
        requests++;
        if (batch.length >= TRUNCATION_HINT && windowDays > 1) {
            // possibly clipped — walk the slice one day at a time instead
            batch = [];
            for (let d = from; d <= to; d = addDays(d, 1)) {
                await sleep(LIVE_REQUEST_GAP_MS);
                batch.push(...await fetchWindow(d, d));
                requests++;
            }
        }
        batch.forEach(c => {
            const k = `${c.EventId || c.CourseIdTrimmed || 'x'}|${c.OccurrenceDate || ''}`;
            if (seen.has(k)) return;
            seen.add(k);
            classes.push(c);
        });
        await sleep(LIVE_REQUEST_GAP_MS);
    }

    const timeRe = /(\d{1,2}):(\d{2})\s*(am|pm)\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)/i;
    const unknownVenues = new Set();
    const learned = (discoveredVenues[sourceKey] ||= {});
    const records = [];
    let skipped = 0;
    classes.forEach(c => {
        const od = String(c.OccurrenceDate || '');
        if (!/^\d{8}$/.test(od)) return;
        const date = `${od.slice(0, 4)}-${od.slice(4, 6)}-${od.slice(6, 8)}`;
        if (date < today || date > end) return;

        let name = String(c.EventName || 'Drop-In Skate').trim();
        if (cfg.cleanName) name = cfg.cleanName(name).trim();
        if (cfg.include && !cfg.include.test(name)) { skipped++; return; }

        const t = timeRe.exec(c.EventTimeDescription || '');
        if (!t) return;
        const startTime = to24h(t[1], t[2], t[3], false);
        const endTime = to24h(t[4], t[5], t[6], false);
        if (!startTime || !endTime) return;

        // "$0.00 - $5.02" → 5.02 (max = standard adult rate; 0 = free tiers);
        // "No fee" (Vaughan) → 0; cfg.priceRules override where the max is a
        // family tier (Markham skates).
        const rangeStr = String(c.PriceRange || '');
        const prices = [...rangeStr.matchAll(/\$([\d.]+)/g)].map(m => parseFloat(m[1]));
        let price = prices.length ? Math.max(...prices) : (/no fee|free/i.test(rangeStr) ? 0 : null);
        const priceRule = (cfg.priceRules || []).find(r => r.match.test(name));
        if (priceRule && price !== 0) price = priceRule.price;

        const rawVenue = String(c.Location || cfg.locationName || `${sourceKey} venue`).trim();
        const venueName = (cfg.venueAliases || {})[rawVenue] || rawVenue;
        let known = (cfg.venues || {})[venueName];
        if (!known) {
            // take coordinates from the feed's Address block when present
            const a = c.Address || {};
            if (typeof a.Latitude === 'number' && typeof a.Longitude === 'number' && a.Latitude) {
                known = learned[venueName] ||= {
                    address: String(a.Street || '').trim(), postalCode: String(a.PostalCode || '').trim(),
                    district: String(a.City || cfg.defaultDistrict || '').trim(), lat: a.Latitude, lng: a.Longitude
                };
            } else {
                unknownVenues.add(venueName);
            }
        }

        records.push(externalRecord(cfg, sourceKey, {
            activity: name,
            date, startTime, endTime, price,
            externalId: `${c.EventId || c.CourseIdTrimmed || 'x'}-${od}`,
            ageMin: c.NoAgeRestriction ? null : (Number.isFinite(c.MinAge) && c.MinAge > 0 ? c.MinAge : null),
            ageMax: c.NoAgeRestriction ? null : (Number.isFinite(c.MaxAge) && c.MaxAge > 0 && c.MaxAge < 120 ? c.MaxAge : null),
            venue: { name: venueName, ...(known || {}), extKey: venueKey(sourceKey, venueName) }
        }));
    });
    if (unknownVenues.size) {
        console.warn(`   📍 ${sourceKey}: venues without coords (feed had none either — add to venues{}): ${[...unknownVenues].join(', ')}`);
    }
    if (Object.keys(learned).length) {
        console.log(`   📍 ${sourceKey}: coordinates learned from the feed for ${Object.keys(learned).join(', ')}`);
    }
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions (${today} → ${end}; ${classes.length} classes, ${skipped} filtered, ${requests} requests)`);
    return records;
}

/**
 * ActiveNet (Mississauga): the online-calendar "multicenter events" feed
 * the city's drop-in calendar page loads. Category-filtered server-side,
 * date-windowed here (the API ignores its own date bounds and returns the
 * whole season, ~2 MB). Titles map to `programs` rules that also carry the
 * by-law price and age band, since the API exposes neither.
 */
async function fetchActiveNet(sourceKey, cfg) {
    const today = torontoDateStr();
    const end = addDays(today, cfg.daysAhead);
    const json = await httpPostJSONBody(`${cfg.base}/onlinecalendar/multicenter/events?locale=en-US`, {
        calendar_id: cfg.calendarId,
        center_ids: cfg.centerIds,
        display_all: 0,
        search_start_time: today,
        search_end_time: end,
        facility_ids: [],
        activity_category_ids: cfg.categoryIds || [],
        activity_sub_category_ids: [], activity_ids: [],
        activity_min_age: null, activity_max_age: null, event_type_ids: []
    });
    const centers = json.body?.center_events || [];
    const records = [];
    const seen = new Set();
    let total = 0, skipped = 0;
    const unknownVenues = new Set();
    centers.forEach(ce => {
        (ce.events || []).forEach(ev => {
            total++;
            const rule = (cfg.programs || []).find(r => r.match.test(String(ev.title || '').trim()));
            if (!rule) { skipped++; return; }
            const start = String(ev.start_time || ''), endT = String(ev.end_time || '');
            const date = start.slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > end) return;
            const startTime = start.slice(11, 16), endTime = endT.slice(11, 16);
            if (!/^\d{2}:\d{2}$/.test(startTime)) return;
            const externalId = `${ev.event_item_id || 'x'}-${date}-${startTime.replace(':', '')}`;
            if (seen.has(externalId)) return;
            seen.add(externalId);
            const venueName = String(ev.center_name || ce.center_name || cfg.locationName || 'Mississauga arena').trim();
            const known = (cfg.venues || {})[venueName];
            if (!known) unknownVenues.add(venueName);
            const free = !!(ev.price && ev.price.free);
            records.push(externalRecord(cfg, sourceKey, {
                activity: rule.activity || ev.title.trim(),
                date, startTime, endTime,
                price: free ? 0 : (rule.defaultPrice ?? null),
                externalId,
                ageMin: rule.ageMin ?? null, ageMax: rule.ageMax ?? null,
                registrationUrl: /^https?:\/\//.test(ev.activity_detail_url || '') ? ev.activity_detail_url : null,
                venue: { name: venueName, ...(known || {}), extKey: venueKey(sourceKey, venueName) }
            }));
        });
    });
    if (unknownVenues.size) console.warn(`   📍 ${sourceKey}: venues without coords in config (add to venues{}): ${[...unknownVenues].join(', ')}`);
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions (${today} → ${end}; ${total} season events, ${skipped} non-skate)`);
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
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
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
 * Optional LLM assist for scraped pages, in order of preference:
 *   1. OLLAMA_URL (+ OLLAMA_MODEL, default llama3.1) — a local model, e.g.
 *      the Dell's Ollama over WireGuard: no key, no data leaves the LAN.
 *   2. ANTHROPIC_API_KEY — Claude Haiku.
 *   3. neither → null, and the regex parser runs (it always can).
 * Any failure at any step falls through — the pipeline never depends on a
 * model being reachable.
 */
const SCHEDULE_PROMPT = (text) => `Extract the public skating schedule from this arena webpage text. Reply with ONLY a JSON array, no prose. Each item: {"weekday":"Monday".."Sunday","start":"HH:MM","end":"HH:MM"(24h),"from":"YYYY-MM-DD"(optional, only if that line is limited to a date range),"to":"YYYY-MM-DD"(optional)}. Times like "12 – 1 pm" are 12:00-13:00. If a line says a special range like "Saturdays June 27 to July 18 2026 from 12noon to 2pm", include from/to.\n\nPAGE TEXT:\n${text.slice(0, 4000)}`;

/** Raw HTTP(S) POST → response text (small helper shared by both model calls). */
function postText(url, body, headers, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'http:' ? require('http') : https;
        const req = mod.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => resolve(d));
            r.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('LLM timeout')));
        req.write(body); req.end();
    });
}

/** Model reply text → validated schedule rules (or null). */
function rulesFromModelText(textOut, label) {
    const jsonMatch = String(textOut || '').match(/\[[\s\S]*\]/);
    const rules = JSON.parse(jsonMatch ? jsonMatch[0] : textOut);
    if (!Array.isArray(rules)) return null;
    const ok = rules.filter(r => WEEKDAYS.includes(r.weekday) && /^\d{2}:\d{2}$/.test(r.start || '') && /^\d{2}:\d{2}$/.test(r.end || ''));
    console.log(`   🤖 ${label} parsed ${ok.length} schedule rules`);
    return ok.length ? ok : null;
}

async function llmParseSchedule(text) {
    const ollama = (process.env.OLLAMA_URL || '').replace(/\/+$/, '');
    if (ollama) {
        try {
            const model = process.env.OLLAMA_MODEL || 'llama3.1';
            const res = await postText(`${ollama}/api/chat`, JSON.stringify({
                model, stream: false, format: 'json',
                options: { temperature: 0 },
                messages: [{ role: 'user', content: SCHEDULE_PROMPT(text) }]
            }), {}, 120000);
            const parsed = JSON.parse(res);
            const out = parsed.message?.content ?? parsed.response ?? '';
            const rules = rulesFromModelText(out, `Ollama (${model})`);
            if (rules) return rules;
        } catch (e) {
            console.warn(`   🤖 Ollama parse skipped (${e.message})`);
        }
    }
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    try {
        const res = await postText('https://api.anthropic.com/v1/messages', JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1000,
            messages: [{ role: 'user', content: SCHEDULE_PROMPT(text) }]
        }), { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, 30000);
        const parsed = JSON.parse(res);
        return rulesFromModelText(parsed.content?.[0]?.text || '', 'Claude');
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

/* ================= HTML / PDF cities (Stouffville, Ajax, Oshawa, Pickering) =================
 *
 * Four municipalities publish no API: two ship a PDF (Whitchurch-Stouffville,
 * Ajax), one hides a server-rendered booking site behind a Queue-it cookie
 * gate (Oshawa) and one embeds plain HTML tables (Pickering). Everything
 * below is dependency-free except `pdftotext` (poppler) for the PDFs, which
 * the workflow apt-installs; without it those two sources fail cleanly and
 * their previous rows are salvaged like any other failed source.
 */

const { execFileSync } = require('child_process');
const os = require('os');

/** One HTTP(S) hop → { status, headers, body: Buffer } (no redirects). */
function httpRequestOnce(url, { headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'http:' ? require('http') : https;
        const req = mod.request(u, { method: 'GET', headers: { 'User-Agent': 'toronto-skating-site-data-fetcher', ...headers } }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error(`Timeout for ${url.substring(0, 90)}`)));
        req.end();
    });
}

/** GET → Buffer, following redirects (binary-safe: PDFs). */
async function httpGetBuffer(url, headers = {}) {
    let cur = url;
    for (let hop = 0; hop < 6; hop++) {
        const r = await httpRequestOnce(cur, { headers });
        if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) { cur = new URL(r.headers.location, cur).href; continue; }
        if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${cur.substring(0, 90)}`);
        return r.body;
    }
    throw new Error(`too many redirects for ${url.substring(0, 90)}`);
}

/**
 * GET with a cookie jar and a manual redirect loop. Oshawa's booking site
 * bounces through a Queue-it waiting room (4 redirects, each setting a
 * cookie the next hop needs); Node's fetch drops cookies between hops and
 * dies with "redirect count exceeded". jar: Map<host, Map<name, value>>.
 */
async function httpGetWithCookies(url, jar, headers = {}) {
    let cur = url;
    for (let hop = 0; hop < 12; hop++) {
        const host = new URL(cur).host;
        const cookies = jar.get(host);
        const cookieHeader = cookies && cookies.size ? { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
        const r = await httpRequestOnce(cur, { headers: { ...headers, ...cookieHeader } });
        (r.headers['set-cookie'] || []).forEach(sc => {
            const [pair] = sc.split(';');
            const eq = pair.indexOf('=');
            if (eq < 1) return;
            if (!jar.has(host)) jar.set(host, new Map());
            jar.get(host).set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        });
        if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) { cur = new URL(r.headers.location, cur).href; continue; }
        if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${cur.substring(0, 90)}`);
        return decodeBody(r.body);
    }
    throw new Error(`too many redirects for ${url.substring(0, 90)}`);
}

/** Follow a chain of pages; each regex's first capture group is the next URL. */
async function discoverUrl(start, hops) {
    let url = start;
    for (const re of hops) {
        const html = await httpGetText(url);
        const m = html.match(re);
        if (!m) throw new Error(`discovery: nothing matched ${re} on ${url.substring(0, 80)}`);
        url = new URL(m[1].replace(/&amp;/g, '&'), url).href;
    }
    return url;
}

/** PDF bytes → layout-preserving text (poppler's pdftotext; CI installs poppler-utils). */
function pdfToLayoutText(buffer) {
    const tmp = path.join(os.tmpdir(), `skate-${process.pid}-${Date.now()}.pdf`);
    fs.writeFileSync(tmp, buffer);
    try {
        return execFileSync('pdftotext', ['-layout', tmp, '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
        throw new Error(e.code === 'ENOENT' ? 'pdftotext not installed (apt-get install poppler-utils)' : `pdftotext failed: ${e.message}`);
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
}

const MONTH_RE = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
const MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** "September 14 – December 20, 2026" / "Effective September 8 to December 18, 2026" → {from, to}. */
function parseSeasonRange(text) {
    const m = String(text || '').match(new RegExp(`${MONTH_RE}\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\s*(?:–|—|-|to)\\s*${MONTH_RE}\\s+(\\d{1,2}),?\\s*(\\d{4})`, 'i'));
    if (!m) return null;
    const y2 = parseInt(m[6], 10), y1 = m[3] ? parseInt(m[3], 10) : y2;
    return { from: ymd(y1, MONTH_NUM[m[1].toLowerCase()], parseInt(m[2], 10)), to: ymd(y2, MONTH_NUM[m[4].toLowerCase()], parseInt(m[5], 10)) };
}

/** "Oct. 12" / "Oct 10, Nov 7, Dec 24, 31" → ['2026-10-12', …]; months before the season start roll into next year. */
function parseDateList(text, season) {
    const out = [];
    const base = season?.from || torontoDateStr();
    const fromY = parseInt(base.slice(0, 4), 10), fromM = parseInt(base.slice(5, 7), 10);
    const re = new RegExp(`${MONTH_RE}\\s+(\\d{1,2})((?:,\\s*\\d{1,2}(?![\\d:]))*)`, 'gi');
    let m;
    while ((m = re.exec(String(text || '')))) {
        const mo = MONTH_NUM[m[1].toLowerCase()];
        const year = mo < fromM ? fromY + 1 : fromY;
        [m[2], ...(m[3] || '').split(',').map(s => s.trim()).filter(Boolean)].forEach(d => out.push(ymd(year, mo, parseInt(d, 10))));
    }
    return out;
}

/** "Monday, September 14, 2026" → '2026-09-14'. */
function parseLongDate(s) {
    const m = String(s || '').match(new RegExp(`${MONTH_RE}\\s+(\\d{1,2}),?\\s*(\\d{4})`, 'i'));
    return m ? ymd(parseInt(m[3], 10), MONTH_NUM[m[1].toLowerCase()], parseInt(m[2], 10)) : null;
}

const TIME_RANGE_RE = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|noon)?\s*(?:–|—|-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|noon)?/i;

/**
 * "6:15pm – 8:15pm", "10 - 11 a.m.", "11:45 a.m. - 1:15 p.m.", "9:15 AM - 10:05 AM"
 * → { start, end } in 24h. A side without am/pm borrows the other side's;
 * "11:45 - 1:15 p.m." flips the start back to the morning when borrowing
 * would put it after the end.
 */
function parseTimeRange(s, { requireMeridiem = false } = {}) {
    const t = String(s || '').match(TIME_RANGE_RE);
    if (!t) return null;
    const norm = x => (x || '').toLowerCase().replace(/\./g, '');
    let sufS = norm(t[3]), sufE = norm(t[6]);
    if (!sufS && !sufE) {
        if (requireMeridiem) return null;
        const start = to24h(t[1], t[2], '', true), end = to24h(t[4], t[5], '', true);
        return start && end && end > start ? { start, end } : null;
    }
    if (!sufS) sufS = sufE;
    if (!sufE) sufE = sufS;
    let start = to24h(t[1], t[2], sufS, false);
    const end = to24h(t[4], t[5], sufE, false);
    if (start && end && end <= start && !t[3]) {
        const flipped = to24h(t[1], t[2], sufS === 'pm' ? 'am' : 'pm', false);
        if (flipped && flipped < end) start = flipped;
    }
    return start && end && end > start ? { start, end } : null;
}

/** "18+", "(7-12 yrs)", "6 yrs & under", "All ages" → { ageMin, ageMax } (null = open). */
function parseAgeText(s) {
    const t = String(s || '').toLowerCase();
    let m;
    if ((m = t.match(/(\d{1,2})\s*(?:yrs?|years?)?\s*(?:&|and)\s*under/))) return { ageMin: null, ageMax: parseInt(m[1], 10) };
    if ((m = t.match(/(\d{1,2})\s*-\s*(\d{1,2})/))) return { ageMin: parseInt(m[1], 10), ageMax: parseInt(m[2], 10) };
    if ((m = t.match(/(\d{1,2})\s*\+/))) return { ageMin: parseInt(m[1], 10), ageMax: null };
    return { ageMin: null, ageMax: null };
}

/**
 * Source-level program rules (first match wins): rename, fix ages, price,
 * or `skip` a program. No rule → the venue's own name and the source's
 * priceRules / defaultPrice.
 */
function applyProgramRules(cfg, rawName) {
    const name = String(rawName || '').replace(/\s+/g, ' ').trim();
    if (!name) return null;
    const rule = (cfg.programs || []).find(r => r.match.test(name));
    if (rule?.skip) return null;
    const price = rule?.price ?? rule?.defaultPrice ?? (cfg.priceRules || []).find(r => r.match.test(name))?.price ?? cfg.defaultPrice ?? null;
    return { activity: rule?.activity || name, ageMin: rule?.ageMin ?? null, ageMax: rule?.ageMax ?? null, price };
}

/**
 * Weekly rules → dated records over cfg.daysAhead. Rule: { venue, activity,
 * weekday, start, end, ageMin, ageMax, price, from, to, except[] }.
 */
function expandWeekly(cfg, sourceKey, rules) {
    const today = torontoDateStr();
    const records = [];
    const seen = new Set();
    for (let i = 0; i < cfg.daysAhead; i++) {
        const date = addDays(today, i);
        const weekday = weekdayOf(date);
        rules.forEach(r => {
            if (r.weekday !== weekday) return;
            if (r.from && date < r.from) return;
            if (r.to && date > r.to) return;
            if (r.except && r.except.includes(date)) return;
            const venueName = r.venue || cfg.locationName;
            const known = (cfg.venues || {})[venueName] || {};
            const externalId = `${venueKey(sourceKey, venueName).replace(/^ext-[^-]+-/, '')}-${date}-${r.start.replace(':', '')}-${normTitle(r.activity).slice(0, 24)}`;
            if (seen.has(externalId)) return;
            seen.add(externalId);
            records.push(externalRecord(cfg, sourceKey, {
                activity: r.activity, date, startTime: r.start, endTime: r.end,
                price: r.price ?? null, externalId,
                ageMin: r.ageMin ?? null, ageMax: r.ageMax ?? null,
                venue: { name: venueName, ...known, extKey: venueKey(sourceKey, venueName) }
            }));
        });
    }
    return records;
}

const describeRules = (rules) => rules.slice(0, 14).map(r => `${r.weekday.slice(0, 3)} ${r.start}-${r.end} ${r.activity}${r.venue ? ` @ ${r.venue.split(' ')[0]}` : ''}`).join(', ') + (rules.length > 14 ? `, … +${rules.length - 14}` : '');

/** "Ages 11-14: 7:00pm – 8:00pm Ages 14-17: 8:00pm – 9:00pm" → [{start, end, age?, note?}, …]. */
function splitGridCell(txt) {
    const out = [];
    const re = new RegExp(TIME_RANGE_RE.source, 'gi');
    let m, lastEnd = 0;
    while ((m = re.exec(txt))) {
        const tr = parseTimeRange(m[0], { requireMeridiem: true });
        if (!tr) continue;                      // "11-14" inside an age label is not a time
        const label = txt.slice(lastEnd, m.index);
        lastEnd = m.index + m[0].length;
        out.push({ ...tr, age: label.match(/ages?\s*[\d\s\-&+]+/i)?.[0] || null, note: label.match(/pad\s*[a-z0-9]+/i)?.[0] || null });
    }
    return out;
}

/**
 * Layout text of a weekday-grid PDF (Whitchurch-Stouffville's drop-in
 * sheet). Per venue block a header line "Activity  Age  Monday … Sunday"
 * fixes the column offsets; each blank-line-separated group of lines is one
 * activity, its cells like "6:15pm – 8:15pm", "PAD 2: 11:15am – 12:15pm" or
 * "Ages 11-14: 7:00pm – 8:00pm". Cells are whole tokens (runs of text with
 * single spaces) assigned to the header whose centre is nearest — a cell
 * may overflow into the next column's half, so fixed slicing would
 * truncate it. Parsing stops at cfg.grid.stopAt.
 */
function parseWeekdayGridText(text, cfg) {
    const venueNames = Object.keys(cfg.venues || {});
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const season = parseSeasonRange(text);
    const rules = [];
    let venue = null, starts = null, group = [];
    const flush = () => {
        if (venue && starts && group.length) {
            const activityParts = [], ageParts = [];
            const cells = dayNames.map(() => []);
            // A token belongs to the column whose header centre is nearest
            // its own centre (cells are centred under their headers).
            const centres = starts.map((x, i) => x + ['Activity', 'Age', ...dayNames][i].length / 2);
            group.forEach(line => {
                for (const m of line.matchAll(/\S+(?: \S+)*/g)) {
                    const mid = m.index + m[0].length / 2;
                    let col = 0;
                    centres.forEach((c, i) => { if (Math.abs(c - mid) < Math.abs(centres[col] - mid)) col = i; });
                    if (col === 0) activityParts.push(m[0]);
                    else if (col === 1) ageParts.push(m[0]);
                    else cells[col - 2].push(m[0]);
                }
            });
            const cls = activityParts.length ? applyProgramRules(cfg, activityParts.join(' ')) : null;
            const ageText = ageParts.join(' ');
            if (cls) {
                dayNames.forEach((weekday, i) => {
                    splitGridCell(cells[i].join(' ')).forEach(c => {
                        const age = parseAgeText(c.age || ageText);
                        rules.push({ venue, activity: cls.activity, weekday, start: c.start, end: c.end,
                            ageMin: cls.ageMin ?? age.ageMin, ageMax: cls.ageMax ?? age.ageMax, price: cls.price,
                            from: season?.from, to: season?.to });
                    });
                });
            }
        }
        group = [];
    };
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\t/g, '    ');
        if (cfg.grid?.stopAt && cfg.grid.stopAt.test(line)) { flush(); break; }
        const vn = venueNames.find(v => line.trim().toLowerCase().startsWith(v.toLowerCase()));
        if (vn) { flush(); venue = vn; starts = null; continue; }
        if (/^\s*Activity\s+Age\s+Monday/i.test(line)) {
            flush();
            const found = ['Activity', 'Age', ...dayNames].map(n => line.indexOf(n));
            starts = found.some(x => x < 0) ? null : found;
            continue;
        }
        if (!line.trim()) { flush(); continue; }
        group.push(line);
    }
    flush();
    return rules;
}

/**
 * Layout text of a per-weekday PDF (Ajax): a line that is just a weekday
 * opens that day; every following "time  activity  pad  exceptions" line is
 * one weekly session ("Unavailable Oct. 9, Nov. 27" → those dates skipped).
 */
function parseWeekdayLinesText(text, cfg) {
    const season = parseSeasonRange(text);
    const rules = [];
    let weekday = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const wd = WEEKDAYS.find(w => line.toLowerCase() === w.toLowerCase());
        if (wd) { weekday = wd; continue; }
        if (!weekday) continue;
        const m = line.match(TIME_RANGE_RE);
        if (!m) continue;
        const tr = parseTimeRange(m[0], { requireMeridiem: true });
        if (!tr) continue;
        const parts = line.slice(m.index + m[0].length).trim().split(/\s{2,}/);
        const cls = applyProgramRules(cfg, parts[0]);
        if (!cls) continue;
        const except = parseDateList((parts.slice(1).join(' ').match(/unavailable[\s\S]*$/i) || [''])[0], season);
        rules.push({ venue: cfg.locationName, activity: cls.activity, weekday, start: tr.start, end: tr.end,
            ageMin: cls.ageMin, ageMax: cls.ageMax, price: cls.price, from: season?.from, to: season?.to, except });
    }
    return rules;
}

/** PDF schedule (weekday grid or weekday lines), discovered from a listing page each run. */
async function fetchPdfSchedule(sourceKey, cfg) {
    if (cfg.activenet) {
        // The Town's ActiveNet calendar exists but was published empty for
        // fall 2026; if it ever fills up it is the better (dated) source.
        try {
            const rows = await fetchActiveNet(sourceKey, { ...cfg, ...cfg.activenet });
            if (rows.length) return rows;
            console.log(`   ↪ ${sourceKey}: ActiveNet calendar is empty — reading the PDF instead`);
        } catch (e) {
            console.warn(`   ↪ ${sourceKey}: ActiveNet check failed (${e.message}) — reading the PDF instead`);
        }
    }
    let pdfUrl = cfg.pdfUrl;
    if (cfg.discover) {
        try { pdfUrl = await discoverUrl(cfg.discover.page, cfg.discover.hops); }
        catch (e) { if (!pdfUrl) throw e; console.warn(`   ↪ ${sourceKey}: ${e.message} — using the last known PDF URL`); }
    }
    console.log(`   📄 ${sourceKey}: ${pdfUrl.substring(0, 110)}`);
    const text = pdfToLayoutText(await httpGetBuffer(pdfUrl));
    const rules = cfg.layout === 'weekday-lines' ? parseWeekdayLinesText(text, cfg) : parseWeekdayGridText(text, cfg);
    if (!rules.length) throw new Error('no sessions parsed from the PDF');
    const season = parseSeasonRange(text);
    console.log(`   📋 ${rules.length} weekly rules${season ? ` (season ${season.from} → ${season.to})` : ''}: ${describeRules(rules)}`);
    const records = expandWeekly(cfg, sourceKey, rules);
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions over next ${cfg.daysAhead} days`);
    return records;
}

/**
 * Intelligenz booking site (Oshawa's "activeOshawa Online"): one
 * server-rendered VenueClasses page per venue covers the whole window; each
 * session is a card with its own date, time, location and capacity.
 */
async function fetchIntelligenz(sourceKey, cfg) {
    const today = torontoDateStr();
    const end = addDays(today, cfg.daysAhead);
    const jar = new Map();
    const records = [];
    const seen = new Set();
    let total = 0, skipped = 0;
    for (const [venueName, v] of Object.entries(cfg.venues || {})) {
        if (!v.guid) continue;
        const url = `${cfg.base}/public/Booking/VenueClasses?GUID=${v.guid}&StartDate=${today}&EndDate=${end}&Participant=00000000-0000-0000-0000-000000000000`;
        const html = await httpGetWithCookies(url, jar);
        html.split(/<div class="card mb-4">/).slice(1).forEach(card => {
            const title = stripHtml((card.match(/<h4[^>]*>([\s\S]*?)<\/h4>/) || [])[1] || '').replace(/\s*★\s*$/, '');
            if (!title) return;
            const dateM = card.match(/Date:\s*<\/span>\s*([A-Za-z]+,\s*[A-Za-z]+\s+\d{1,2},\s*\d{4})/);
            const timeM = card.match(/Time:\s*<\/span>\s*([^<]+)/);
            if (!dateM || !timeM) return;
            total++;
            if (!cfg.activityMatch.test(title)) { skipped++; return; }
            const date = parseLongDate(dateM[1]);
            const tr = parseTimeRange(timeM[1]);
            if (!date || !tr || date < today || date > end) return;
            const cls = applyProgramRules(cfg, title.replace(/\s*\([^)]*\)\s*$/, ''));
            if (!cls) return;
            const age = parseAgeText(title);
            const externalId = `${v.guid.slice(0, 8)}-${date}-${tr.start.replace(':', '')}-${normTitle(title).slice(0, 20)}`;
            if (seen.has(externalId)) return;
            seen.add(externalId);
            records.push(externalRecord(cfg, sourceKey, {
                activity: cls.activity, date, startTime: tr.start, endTime: tr.end,
                price: cls.price, externalId,
                ageMin: cls.ageMin ?? age.ageMin, ageMax: cls.ageMax ?? age.ageMax,
                venue: { name: venueName, address: v.address, district: v.district, postalCode: v.postalCode, lat: v.lat, lng: v.lng, extKey: venueKey(sourceKey, venueName) }
            }));
        });
    }
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions (${today} → ${end}; ${total} venue bookings seen, ${skipped} non-skate)`);
    return records;
}

/** Minimal HTML table reader → [[cell, …], …] per table (tags stripped). */
function parseHtmlTables(html) {
    return [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map(t =>
        [...t[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(r =>
            [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => stripHtml(c[1]))));
}

/**
 * Weekday-grid HTML tables (Pickering): per venue a table whose first row is
 * the venue name, second row the program columns, then one row per weekday.
 * Season per program and the "Cancellation Dates" list come from the page
 * text around the tables.
 */
async function fetchHtmlGrid(sourceKey, cfg) {
    const html = await httpGetText(cfg.url);
    const text = stripHtml(html);
    const venueNames = Object.keys(cfg.venues || {});
    const resolveVenue = (label) => {
        const l = String(label || '').toLowerCase().replace(/\s+/g, ' ');
        return venueNames.find(v => l.startsWith(v.toLowerCase()))
            || Object.entries(cfg.venueAliases || {}).find(([a]) => l.startsWith(a.toLowerCase()))?.[1] || null;
    };
    const seasonFor = (activity) => {
        const s = (cfg.seasons || []).find(x => x.match.test(activity));
        if (!s) return null;
        const i = text.search(s.label);
        return i >= 0 ? parseSeasonRange(text.slice(i, i + 120)) : null;
    };
    // Cancellation block: "<label>: [<venue> - ]Oct 10, Nov 7 …" per program group.
    const cancels = [];
    const ci = text.search(/Cancellation Dates/i);
    if (ci >= 0) {
        const block = text.slice(ci, ci + 900);
        const marks = (cfg.cancelGroups || []).map(g => ({ g, i: block.search(g.label) })).filter(x => x.i >= 0).sort((a, b) => a.i - b.i);
        marks.forEach((mk, k) => {
            const seg = block.slice(mk.i, marks[k + 1] ? marks[k + 1].i : undefined);
            const hits = [...venueNames.map(n => [n, n]), ...Object.entries(cfg.venueAliases || {})]
                .map(([alias, name]) => ({ name, i: seg.toLowerCase().indexOf(alias.toLowerCase()) })).filter(h => h.i >= 0).sort((a, b) => a.i - b.i);
            const season = seasonFor(mk.g.matchSample || '') || null;
            if (!hits.length) { cancels.push({ match: mk.g.match, venue: null, dates: parseDateList(seg, season) }); return; }
            hits.forEach((h, j) => cancels.push({ match: mk.g.match, venue: h.name, dates: parseDateList(seg.slice(h.i, hits[j + 1] ? hits[j + 1].i : undefined), season) }));
        });
    }
    const rules = [];
    parseHtmlTables(html).forEach(rows => {
        if (rows.length < 3 || rows[0].length !== 1) return;
        const venue = resolveVenue(rows[0][0]);
        if (!venue) return;
        const header = rows[1];
        rows.slice(2).forEach(row => {
            const weekday = WEEKDAYS.find(w => w.toLowerCase() === String(row[0] || '').trim().toLowerCase());
            if (!weekday) return;
            row.slice(1).forEach((cell, i) => {
                const tr = parseTimeRange(cell, { requireMeridiem: true });
                if (!tr) return;
                const cls = applyProgramRules(cfg, header[i + 1]);
                if (!cls) return;
                const season = seasonFor(cls.activity);
                const except = cancels.filter(c => c.match.test(cls.activity) && (!c.venue || c.venue === venue)).flatMap(c => c.dates);
                rules.push({ venue, activity: cls.activity, weekday, start: tr.start, end: tr.end, ageMin: cls.ageMin, ageMax: cls.ageMax, price: cls.price, from: season?.from, to: season?.to, except });
            });
        });
    });
    if (!rules.length) throw new Error('no schedule tables parsed from the page');
    console.log(`   📋 ${rules.length} weekly rules: ${describeRules(rules)}`);
    if (cancels.length) console.log(`   🚫 cancellations: ${cancels.map(c => `${c.venue ? c.venue.split(' ')[0] + ' ' : ''}${c.match.source} ${c.dates.join(' ')}`).join(' | ')}`);
    const records = expandWeekly(cfg, sourceKey, rules);
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

/** Source kind → fetcher. */
const FETCHERS = { daysmart: fetchDaySmart, perfectmind: fetchPerfectMind, activenet: fetchActiveNet, scrape: fetchScraped, pdf: fetchPdfSchedule, intelligenz: fetchIntelligenz, 'html-grid': fetchHtmlGrid };

async function fetchExternalSources() {
    const bySource = {};
    for (const [key, cfg] of Object.entries(EXTERNAL_SOURCES)) {
        console.log(`\n🌐 External source: ${key}`);
        try {
            const fetcher = FETCHERS[cfg.kind];
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
        if (ONLY.length) {
            for (const key of ONLY) {
                const cfg = EXTERNAL_SOURCES[key];
                if (!cfg) { console.warn(`⚠️ unknown source '${key}' (known: ${Object.keys(EXTERNAL_SOURCES).join(', ')})`); continue; }
                console.log(`\n🌐 External source: ${key} (dry run)`);
                try {
                    const rows = await FETCHERS[cfg.kind](key, cfg);
                    rows.slice(0, 10).forEach(r => console.log(`     ${r['Start Date']} ${r['Day of Week'].slice(0, 3)} ${r['Start Time']}–${r['End Time']}  ${r.Activity}  @ ${r.LocationName}` +
                        `${r.Paid ? `  $${r.Price}` : '  free'}${r['Age Min'] != null || r['Age Max'] != null ? `  ages ${r['Age Min'] ?? ''}–${r['Age Max'] ?? ''}` : ''}`));
                    if (rows.length > 10) console.log(`     … ${rows.length - 10} more`);
                } catch (e) {
                    console.warn(`   ⚠️ ${key} failed: ${e.message}`);
                }
            }
            return;
        }
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

if (require.main === module) main();
module.exports = { llmParseSchedule, parseScheduleText, fetchLiveCheck, EXTERNAL_SOURCES, parseTimeRange, parseSeasonRange, parseDateList, parseWeekdayGridText, parseWeekdayLinesText };

