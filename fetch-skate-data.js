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
 *   node fetch-skate-data.js --reader-selftest  # one made-up alert through each configured alert-reader tier
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
const crypto = require('crypto');

const PACKAGE_ID ='1a5be46a-4039-48cd-a2d2-8e702abf9516';
const BASE_URL = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action';
// Script lives at the repo root, but the app reads from skate/projects/data/
// (SKATE_OUTPUT_DIR: a rehearsal run into a scratch copy of the data folder, nothing published.)
const OUTPUT_DIR = process.env.SKATE_OUTPUT_DIR || path.join(__dirname, 'skate', 'projects', 'data');

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
    /* ---- Toronto's board-run arenas: City-owned, own websites, never in the City export ---- */
    'grossman': {
        kind: 'scrape',
        url: 'https://larrygrossmanforesthillarena.com/recreational-skating-hours/',
        daysAhead: 28,
        activity: 'Pleasure Skate',
        locationName: 'Larry Grossman Forest Hill Memorial Arena',
        locationId: 3489,
        address: '340 Chaplin Cres', district: 'Toronto and East York', postalCode: 'M5P 1A9',
        lat: 43.7042503753, lng: -79.4201852796,
        season: { from: '10-01', to: '04-30', lead: 45 },
        paid: true, price: 3, priceNote: '$3 per person, pay at the door',
        unverified: true,
        infoUrl: 'https://larrygrossmanforesthillarena.com/recreational-skating-hours/'
    },
    'leaside-public': {
        kind: 'scrape',
        url: 'https://leasidegardens.com/arenas/public-skate-times/',
        section: { from: /Public Skating Drop-In/i, to: /Adult Shinny/i },
        only: /ADULTS ONLY/i,
        daysAhead: 28,
        activity: 'Public Skating: Adults 18+',
        ageMin: 18,
        locationName: 'Leaside Memorial Community Gardens',
        locationId: 789,
        address: '1073 Millwood Rd', district: 'Toronto and East York', postalCode: 'M4G 1X6',
        lat: 43.7016796841, lng: -79.3612191537,
        paid: false, unverified: true,
        infoUrl: 'https://leasidegardens.com/arenas/public-skate-times/'
    },
    'leaside-community': {
        kind: 'scrape',
        url: 'https://leasidegardens.com/arenas/public-skate-times/',
        section: { from: /Public Skating Drop-In/i, to: /Adult Shinny/i },
        only: /Community Skate/i,
        daysAhead: 28,
        activity: 'Community Skate: All Ages',
        locationName: 'Leaside Memorial Community Gardens',
        locationId: 789,
        address: '1073 Millwood Rd', district: 'Toronto and East York', postalCode: 'M4G 1X6',
        lat: 43.7016796841, lng: -79.3612191537,
        paid: false, unverified: true,
        infoUrl: 'https://leasidegardens.com/arenas/public-skate-times/'
    },
    'leaside-pickuphub': {
        kind: 'pickuphub',
        slug: 'leaside-gardens',          // https://pickuphub.net/leaside-gardens
        daysAhead: 35,
        // PickupHub sport slug → how the app names the session (a pad name is appended)
        activities: { 'figure-skating': 'Figure Skating Ticket Ice', 'ice-hockey': 'Adult Shinny' },
        ageMin: 18,
        locationName: 'Leaside Memorial Community Gardens',
        locationId: 789,
        address: '1073 Millwood Rd', district: 'Toronto and East York', postalCode: 'M4G 1X6',
        lat: 43.7016796841, lng: -79.3612191537,
        paid: true, priceNote: 'HST included · register on PickupHub, sessions fill up',
        infoUrl: 'https://pickuphub.net/leaside-gardens'
    },
    'bolton-public': {
        kind: 'scrape',
        url: 'https://www.billboltonarena.ca/public-skating',
        section: { from: /General Public/i, to: /Adults Only/i },
        daysAhead: 28,
        activity: 'Public Skating (Free)',
        locationName: 'William H. Bolton Arena',
        locationId: 3495,
        address: '40 Rossmore Rd', district: 'Toronto and East York', postalCode: 'M6G 4C7',
        lat: 43.6711959361, lng: -79.4152061268,
        paid: false, unverified: true,
        infoUrl: 'https://www.billboltonarena.ca/public-skating'
    },
    'bolton-adult': {
        kind: 'scrape',
        url: 'https://www.billboltonarena.ca/public-skating',
        section: { from: /Adults Only/i, to: /Parent/i },
        daysAhead: 28,
        activity: 'Adults Only Skate (18+)',
        ageMin: 18,
        locationName: 'William H. Bolton Arena',
        locationId: 3495,
        address: '40 Rossmore Rd', district: 'Toronto and East York', postalCode: 'M6G 4C7',
        lat: 43.6711959361, lng: -79.4152061268,
        paid: false, unverified: true,
        infoUrl: 'https://www.billboltonarena.ca/public-skating'
    },
    'bolton-tots': {
        kind: 'scrape',
        url: 'https://www.billboltonarena.ca/public-skating',
        section: { from: /Parent\s*&\s*Tots?/i, to: /rental/i },
        daysAhead: 28,
        activity: 'Parent & Tots Skate (4 and under)',
        ageMax: 4,
        locationName: 'William H. Bolton Arena',
        locationId: 3495,
        address: '40 Rossmore Rd', district: 'Toronto and East York', postalCode: 'M6G 4C7',
        lat: 43.6711959361, lng: -79.4152061268,
        paid: false, unverified: true,
        infoUrl: 'https://www.billboltonarena.ca/public-skating'
    },
    /* ---- v3.12: the remaining board-run arenas -------------------------------------------
     * All eight boards are now represented. Four publish no schedule to read:
     *   - George Bell: weekly free skates on its own site (read below).
     *   - McCormick: closed for renovations; its schedule page is read so the sessions
     *     come back by themselves when the board posts a season again.
     *   - Ted Reeve, North Toronto: no public skating on the indoor pad. kind 'watch'
     *     re-reads the sentence that says so, and flags the page if it changes.
     */
    'georgebell': {
        kind: 'venue', reader: 'georgeBell',
        url: 'https://georgebellarena.com/public-skating',
        daysAhead: 28,
        activity: 'Public Skating',
        locationName: 'George Bell Arena',
        locationId: 3488,
        address: '215 Ryding Ave', district: 'Etobicoke York', postalCode: 'M6N 1H6',
        lat: 43.6684431016, lng: -79.4773579435,
        // The page gives weekly hours and no season. Its older layout dated its season September 3 to March 27,
        // so outside September to mid-April the hours are not taken at their word: the source sleeps.
        season: { from: '09-01', to: '04-15', lead: 21 },
        paid: false, unverified: true,
        infoUrl: 'https://georgebellarena.com/public-skating',
        // The City's rink page still carries its 2025 "Under Construction" notice, while the
        // board's own site says the arena reopened on October 10 (2026) and lists weekly skates.
        // While that sentence is on the board's home page, a City notice of that kind posted
        // before the reopening is shown as a grey note instead of cancelling every session.
        reopened: { on: '2026-10-10', url: 'https://georgebellarena.com/', says: /opened for regular activities\s+October\s+10/i, notice: /construction|improvements/i }
    },
    'mccormick': {
        kind: 'venue', reader: 'mccormick',
        url: 'https://www.mccormickarena.com/page2.html',
        daysAhead: 28,
        activity: 'Public Skating',
        locationName: 'McCormick Arena',
        locationId: 3490,
        address: '179 Brock Ave', district: 'Toronto and East York', postalCode: 'M6K 2L7',
        lat: 43.6472384221, lng: -79.4339412246,
        paid: false, unverified: true,
        infoUrl: 'http://www.mccormickarena.com/'
    },
    'tedreeve': {
        kind: 'watch',
        url: 'https://tedreevearena.com/',
        says: /Ted Reeve does not offer Pleasure Skating/i,
        locationName: 'Ted Reeve Community Arena', locationId: 3494,
        infoUrl: 'https://tedreevearena.com/'
    },
    'northtoronto': {
        kind: 'watch',
        url: 'https://www.ntarena.ca/',
        says: /Public Skating\s+(?:on|is offered at|offered at)\s+the Eglinton Park Outdoor Rink/i,
        locationName: 'North Toronto Memorial Arena', locationId: 3492,
        infoUrl: 'https://www.ntarena.ca/'
    },

    /* ---- v3.12: seasonal rinks that publish their own hours -------------------------------
     * kind 'venue': the page is fetched here and read by a pure function in skate-venues.js,
     * which answers open / pending / closed / unknown and only then lists sessions. Each has
     * a `season` (month-day bounds plus a lead-in): outside it the page is not fetched at all
     * and the source reads "out of season" instead of failing. Outdoor ice is tagged outdoor.
     */
    'harbourfront': {
        kind: 'venue', reader: 'harbourfront',
        url: 'https://harbourfrontcentre.com/program/skate/',
        daysAhead: 14,
        activity: 'Public Skating (Free)',
        locationName: 'Harbourfront Centre Rink',
        address: '235 Queens Quay W', district: 'Toronto and East York', postalCode: 'M5J 2G8',
        lat: 43.639392, lng: -79.382026,
        kinds: ['outdoor'],
        season: { from: '11-15', to: '03-31', lead: 30 },
        paid: false, unverified: true,
        priceNote: 'Outdoor ice, weather permitting. Resurfacing breaks through the day',
        infoUrl: 'https://harbourfrontcentre.com/program/skate/'
    },
    'bentway': {
        kind: 'venue', reader: 'bentway',
        url: 'https://thebentway.ca/wp-json/wp/v2/event?slug=winter-skating',
        daysAhead: 28,
        activity: 'Public Skating (Free)',
        locationName: 'The Bentway Skate Trail',
        address: '250 Fort York Blvd', district: 'Toronto and East York', postalCode: 'M5V 3K9',
        lat: 43.637793, lng: -79.406306,
        kinds: ['outdoor'],
        season: { from: '12-01', to: '03-15', lead: 45 },
        paid: false, unverified: true,
        priceNote: 'Outdoor trail, weather permitting',
        infoUrl: 'https://thebentway.ca/event/winter-skating/'
    },
    'evergreen': {
        kind: 'venue', reader: 'evergreen',
        url: 'https://www.evergreen.ca/evergreen-brick-work/activities/free-public-skate/',
        daysAhead: 28,
        activity: 'Public Skating (Free)',
        locationName: 'Evergreen Brick Works',
        address: '550 Bayview Ave', district: 'Toronto and East York', postalCode: 'M4W 3X8',
        lat: 43.684335, lng: -79.367288,
        kinds: ['outdoor'],
        season: { from: '12-01', to: '03-15', lead: 45 },
        paid: false, unverified: true,
        priceNote: 'Outdoor ice under an open roof, weather permitting',
        infoUrl: 'https://www.evergreen.ca/evergreen-brick-work/activities/free-public-skate/'
    },
    'mattamy': {
        kind: 'venue', reader: 'mattamy',
        url: 'https://www.mattamyathleticcentre.ca/venue-info/community-skates',
        daysAhead: 150,              // four dated skates a winter: list them all as soon as they are posted
        activity: 'Community Skate (Free)',
        locationName: 'Mattamy Athletic Centre',
        address: '50 Carlton St', district: 'Toronto and East York', postalCode: 'M5B 1J2',
        lat: 43.661820, lng: -79.380310,
        season: { from: '12-01', to: '04-15', lead: 75 },
        paid: false, unverified: true,
        priceNote: 'No skate rentals. Helmets required under 6. First 200 skaters',
        infoUrl: 'https://www.mattamyathleticcentre.ca/venue-info/community-skates'
    },
    'fordperformance': {
        kind: 'calendar-image',
        // Ford Performance Centre (run by Lakeshore Arena Corporation) posts each month as a
        // picture on its drop-in page ("November-1.png"). Each new picture is read once by the
        // alert reader's model and checked date by date (see "Monthly calendar pictures").
        // Only its free community skates are listed: stick & puck and shinny show on the
        // pictures some months, with fees the pictures do not give.
        url: 'https://www.lakeshorearena.ca/programs/',
        locationId: 475,                                  // the City lists the arena as location 475
        keep: [{ match: /community skate|public skat|free skat/i, activity: 'Community Skate (Free)' }],
        daysAhead: 60,
        locationName: 'Ford Performance Centre',
        address: '400 Kipling Ave', district: 'Etobicoke York', postalCode: 'M8V 3L1',
        lat: 43.6029579, lng: -79.5199134,
        kinds: ['indoor'],
        paid: false, unverified: true,
        priceNote: 'Free, courtesy of Ford. CSA helmets required for 6 and under, strongly recommended for 7 and older',
        infoUrl: 'https://www.lakeshorearena.ca/programs/'
    },
    'yzd': {
        kind: 'manual',
        // yzd.ca keeps the hours behind /api/, which its robots.txt disallows, so they are
        // entered here by hand from the page as a visitor sees it (read 2026-11-21, the page
        // was last edited 2026-11-20). The public page is still fetched every run: if it goes
        // away or stops being about Hangar Skate, the status page says so. And the site's page
        // list (sitemap.xml, which robots.txt allows) says when the page was last edited: an
        // edit after `seen` shows on the status page as "its page was edited", so the hours
        // get a second look.
        //
        // TO ENTER NEW HOURS (a new winter, or after an edit):
        //   1. Read the hours on https://www.yzd.ca/event/hangar-skate as a visitor.
        //   2. Set `dates` (first and last day), `rules` (one line per run of weekdays with the
        //      same hours), `closedOn` (dates with no skating), and `enteredOn` (today).
        //   3. Set `watch.seen` to the page's edit time: `node fetch-skate-data.js --only=yzd`
        //      prints it ("its page was last edited …").
        //   4. Run that command again: it lists the sessions it will publish. Compare with the page.
        //   5. In skate/tests/unit/sources.spec.js, update the two "hours entered by hand (YZD)"
        //      tests to the new dates, then `npx playwright test --project=unit`.
        //   6. Commit fetch-skate-data.js and the test, push. The next run (30 min) publishes them.
        enteredOn: '2026-11-23',          // first entered Nov 21; checked again Nov 23 against the page as edited that morning
        watch: { url: 'https://www.yzd.ca/event/hangar-skate', says: /<title>[^<]*Hangar Skate/i,
                 sitemap: 'https://www.yzd.ca/sitemap.xml', seen: '2026-11-23T09:21:52Z' },   // the edit of Nov 23, checked against these hours that day
        dates: { from: '2026-12-19', to: '2027-02-15' },
        rules: [
            { from: '2026-12-19', to: '2027-01-03', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Saturday', 'Sunday'], start: '12:00', end: '17:00' },
            { from: '2026-12-19', to: '2027-01-03', days: ['Friday'], start: '18:00', end: '22:00' },
            { from: '2027-01-08', to: '2027-02-15', days: ['Saturday', 'Sunday'], start: '12:00', end: '17:00' },
            { from: '2027-01-08', to: '2027-02-15', days: ['Friday'], start: '18:00', end: '22:00' }
        ],
        // Read again 2026-11-23: the page names no Christmas Day closure (its only closure is
        // Jan 4 to 7, between the two rule sets), and its Friday DJ skates run "Jan. 8 – Feb. 15".
        // The whole season is listed: these hours are known in full, not a feed with a horizon.
        closedOn: [],
        daysAhead: 90,
        activity: 'Public Skating (Free)',
        locationName: 'YZD Hangar Skate',
        address: '34 Hanover Rd', district: 'North York', postalCode: '',
        lat: 43.7375239, lng: -79.4695391,
        kinds: ['outdoor'],
        season: { from: '12-10', to: '02-28', lead: 45 },
        paid: false, unverified: true,
        priceNote: 'Outdoor ice, weather permitting. Hours entered by hand from yzd.ca',
        infoUrl: 'https://www.yzd.ca/event/hangar-skate'
    },
    'mississauga-square': {
        kind: 'venue', reader: 'mississaugaSquare',
        url: 'https://www.mississauga.ca/arts-and-culture/locations/celebration-square/venue-info/',
        daysAhead: 14,
        activity: 'Public Skating (Free)',
        locationName: 'Celebration Square Rink',
        address: '300 City Centre Dr', district: 'Mississauga', postalCode: 'L5B 3C9',
        lat: 43.588945, lng: -79.644618,
        kinds: ['outdoor'],
        season: { from: '11-15', to: '03-31', lead: 30 },
        paid: false, unverified: true,
        priceNote: 'Outdoor ice, weather permitting',
        infoUrl: 'https://www.mississauga.ca/arts-and-culture/locations/celebration-square/venue-info/'
    },
    'brampton-outdoor': {
        kind: 'venue', reader: 'bramptonOutdoor',
        url: 'https://www.brampton.ca/EN/residents/Recreation/Programs-Activities/Pages/Outdoor-Skating.aspx',
        // Gore Meadows keeps a program schedule on its own page; the table only says "see schedule".
        also: [{ reader: 'bramptonGoreMeadows', venue: 'Gore Meadows Covered Outdoor Rink',
                 url: 'https://www.brampton.ca/EN/residents/Recreation/Programs-Activities/Pages/outdoor-skating-Gore-Meadows-Covered-Outdoor-Skating-Rink.aspx' }],
        daysAhead: 14,
        activity: 'Public Skating',
        // One row of the City's table per rink. `match` finds the row whatever suffix the page
        // gives the name this year ("… Outdoor Skating Rink", "… Skating Recreational Trail").
        venueList: [
            { name: 'Gore Meadows Covered Outdoor Rink', match: /gore meadows/i,        address: '10150 The Gore Rd',       lat: 43.7942581, lng: -79.6950445 },
            { name: 'Gage Park Skating Trail',           match: /gage park/i,           address: 'Main St S at Wellington St W', lat: 43.683244,  lng: -79.7573186 },
            { name: 'Chinguacousy Park Skating Trail',   match: /chinguacousy/i,        address: '9050 Bramalea Rd',        lat: 43.725873,  lng: -79.722135 },
            { name: 'Mount Pleasant Outdoor Rink',       match: /mount pleasant/i,      address: '100 Commuter Dr',         lat: 43.6768591, lng: -79.8240277 },
            { name: 'Sandalwood Park Outdoor Rinks',     match: /sandalwood/i,          address: '130 Conestoga Dr',        lat: 43.724326,  lng: -79.795886 },
            { name: 'Flower City Community Campus Outdoor Rink', match: /flower city/i, address: '8850 McLaughlin Rd',      lat: 43.672733,  lng: -79.770307 },
            { name: 'Boreham Park Rink',                 match: /boreham/i,             address: '350 Conservation Dr',     lat: 43.734163,  lng: -79.806960 },
            { name: 'Bovaird House Rink',                match: /bovaird house/i,       address: '563 Bovaird Dr E',        lat: 43.716642,  lng: -79.775074 },
            { name: 'Amore Italian Park Rink',           match: /amore/i,               address: '70 Halliford Pl',         lat: 43.757126,  lng: -79.687361 },
            { name: 'Carabram Park Rink',                match: /carabram/i,            address: '79 Eagleridge Dr',        lat: 43.762572,  lng: -79.737937 },
            { name: 'Duggan Park Rink',                  match: /duggan/i,              address: '75 Vodden St E',          lat: 43.6964015, lng: -79.7650896 },
            { name: 'Major William Sharpe Park Rink',    match: /william sharpe/i,      address: 'Phelps Dr',               lat: 43.673313,  lng: -79.783677 },
            { name: 'Monkton Circle Park Rink',          match: /monkton/i,             address: '16 Beechmont Dr',         lat: 43.659823,  lng: -79.785662 },
            { name: 'Sesquicentennial Park Rink',        match: /sesquicentennial/i,    address: '11475 Bramalea Rd',       lat: 43.768718,  lng: -79.771098 },
            { name: 'Treleaven Park Rink',               match: /treleaven/i,           address: '58 Harold St',            lat: 43.676153,  lng: -79.756129 },
            { name: 'Peel Village Park Rink',            match: /peel village/i,        address: '47 Watson Cres',          lat: 43.676461,  lng: -79.735036 }
        ],
        defaultDistrict: 'Brampton',
        kinds: ['outdoor'],
        season: { from: '11-01', to: '03-31', lead: 30 },
        paid: false, unverified: true,
        priceNote: 'Outdoor ice, weather permitting. Free, no registration',
        infoUrl: 'https://www.brampton.ca/EN/residents/Recreation/Programs-Activities/Pages/Outdoor-Skating.aspx'
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
    /* ---- v3.14: Aurora and Newmarket (York Region) ---- */
    'aurora': {
        kind: 'aurora',
        // The Town of Aurora posts its drop-ins as tables on one page: per arena and season a
        // heading with the dates ("Fall 2026: September 8 to December 20, 2026"), then a row per
        // day ("1 p.m. to 2 p.m. – Parent/Child Stick & Puck") with ">Cancelled: …" lines and
        // holiday rows dated in full ("Monday, February 15"). Read by parseAuroraPage.
        url: 'https://www.aurora.ca/recreation-arts-and-culture/recreation-programs-and-drop-in-activities/drop-in-activities/skating-activities/',
        daysAhead: 28,
        paid: true,
        // Its own price list (same page): public skating $3.37 per person, shinny $7.23, goalies free.
        // Stick & puck's fee is not given there.
        programs: [
            { match: /stick/i, price: null },
            { match: /shinny/i, price: 7.23 },
            { match: /./, price: 3.37 }
        ],
        // Ages from the page's descriptions, where the title does not say them
        ageRules: [
            { match: /senior/i, ageMin: 55 },
            { match: /family shinny/i, ageMin: 6, ageMax: 10 },
            { match: /adult|men[’']s|ladies/i, ageMin: 18 }
        ],
        priceNote: 'Pay at the arena: public skating $3.37, shinny $7.23 per person (goalies free)',
        venues: {
            'Aurora Family Leisure Complex': { match: /family leisure|a\.f\.l\.c/i, address: '135 Industrial Pkwy N', district: 'Aurora', postalCode: '', lat: 44.0080564, lng: -79.4594168 },
            'Aurora Recreation Complex':     { match: /recreation complex|a\.r\.c/i, address: '1400 Wellington St E', district: 'Aurora', postalCode: '', lat: 44.0098616, lng: -79.4234044 }
        },
        district: 'Aurora',
        unverified: true,      // a page of tables, no live feed: check before a long drive
        infoUrl: 'https://www.aurora.ca/recreation-arts-and-culture/recreation-programs-and-drop-in-activities/drop-in-activities/skating-activities/'
    },
    'newmarket': {
        kind: 'pdf',
        layout: 'day-grid',
        // The Town of Newmarket posts each season's public skating as a one-page PDF: per arena a
        // line "Effective September 9 to December 19, 2026", the days across, the activities down
        // (labels over two or three lines, two times in one cell joined by "and"). Read by
        // parseDayGridText. The PDF's address changes each season: found on the schedules page.
        discover: { page: 'https://www.newmarket.ca/schedules', hops: [/href="([^"]*\/media\/file\/public-skating-[^"]*drop[^"]*schedule[^"]*)"/i] },
        pdfUrl: 'https://www.newmarket.ca/media/file/public-skating-fall-2026-drop-schedule',
        grid: { stopAt: /Participants must|Maximum of \d+ skaters|For parents to teach/i },
        daysAhead: 28,
        paid: true,
        priceNote: 'Pay at the Customer Service kiosk before the program; the fee is not on the schedule. Check in opens half an hour before',
        venues: {
            'Magna Centre':                   { address: '800 Mulock Dr', district: 'Newmarket', postalCode: '', lat: 44.0438385, lng: -79.4389729 },
            'Ray Twinney Recreation Complex': { address: '100 Eagle St W', district: 'Newmarket', postalCode: '', lat: 44.0446985, lng: -79.4866557 }
        },
        district: 'Newmarket',
        unverified: true,
        infoUrl: 'https://www.newmarket.ca/schedules'
    },
    'newmarket-shinny': {
        kind: 'pdf',
        layout: 'day-grid',
        // The same grid for shinny ("7 to 7:50 a.m. & 12:30 to 1:20 p.m."), all at the Magna Centre;
        // the young groups go by birth year ("2017 to 2019 Shinny").
        discover: { page: 'https://www.newmarket.ca/schedules', hops: [/href="([^"]*\/media\/file\/shinny-[^"]*drop[^"]*schedule[^"]*)"/i] },
        pdfUrl: 'https://www.newmarket.ca/media/file/shinny-fall-2026-drop-schedule',
        grid: { stopAt: /^\s*Shinny:|^\s*Admission:/i, venue: 'Magna Centre' },
        daysAhead: 28,
        paid: true,
        priceNote: 'Full equipment and a CSA helmet; 17 and under also a mouth guard, neck guard and full face protection. Pay at the kiosk first',
        venues: {
            'Magna Centre': { address: '800 Mulock Dr', district: 'Newmarket', postalCode: '', lat: 44.0438385, lng: -79.4389729 }
        },
        district: 'Newmarket',
        unverified: true,
        infoUrl: 'https://www.newmarket.ca/schedules'
    },
    /* ---- v3.15: King Township, Whitby, U of T ---- */
    'king': {
        kind: 'perfectmind',
        // Township of King, PerfectMind org 23793 (the tenant is part of the address), calendar
        // "Skating": public, 55+, parent & tot, adaptive, figure, family stick & puck and shinny at
        // three arenas, with each session's own fee.
        base: 'https://townshipofking.perfectmind.com/23793',
        widgetId: '15f6af07-39c5-473e-b053-96653f77a406',
        calendarId: '2fd6d540-75aa-416b-9a70-a78b8f598e7d',
        daysAhead: 28,
        windowDays: 3,
        paid: true,
        venues: {
            'Zancor Centre':                     { address: '1600 15th Sideroad', district: 'King City', postalCode: 'L7B 1B3', lat: 43.9515368, lng: -79.5125525 },
            'Trisan Centre':                     { address: '25 Dillane Dr',      district: 'Schomberg', postalCode: 'L0G 1T0', lat: 44.0076708, lng: -79.6733253 },
            'Nobleton Arena & Community Centre': { address: '15 Sheardown Dr',    district: 'Nobleton',  postalCode: 'L0G 1N0', lat: 43.9051671, lng: -79.6604000 }
        },
        district: 'King',
        // the Township's own booking page for this calendar (a guessed king.ca address was a 404)
        infoUrl: 'https://townshipofking.perfectmind.com/23793/Clients/BookMe4BookingPages/Classes?calendarId=2fd6d540-75aa-416b-9a70-a78b8f598e7d&widgetId=15f6af07-39c5-473e-b053-96653f77a406&embed=False'
    },
    'whitby': {
        kind: 'whitby',
        // The Town of Whitby posts one accordion per arena ("Fall/Winter Skate Schedule - Iroquois Park
        // Sports Centre (500 Victoria St. W.) - September 8, 2026 - March 28, 2027"), each a table of
        // Day | Time | Type | Cancellations. A day cell can name several weekdays and an age in brackets
        // ("Saturday (8-12yrs)"); cancellations carry their month forward ("January 1, 8, and March 26").
        url: 'https://www.whitby.ca/explore-and-enjoy/parks-and-recreation/skating-schedules-and-arenas/',
        daysAhead: 28,
        paid: true,
        // Its own fee list (same page, HST extra): adult skate $5.12, shinny $7.69. Others are not given there.
        programs: [
            { match: /shinny/i, price: 7.69 },
            { match: /adult/i, price: 5.12 },
            { match: /^recreational$/i, activity: 'Recreational Public Skate' }
        ],
        ageRules: [{ match: /adult|ladies/i, ageMin: 18 }, { match: /parent and tot/i, ageMax: 7 }],
        priceNote: 'Pay at the arena (HST extra): adult skate $5.12, shinny $7.69; see whitby.ca for the rest',
        venues: {
            'Iroquois Park Sports Centre': { match: /iroquois/i,  address: '500 Victoria St W',   district: 'Whitby', postalCode: 'L1N 9B4', lat: 43.8638, lng: -78.9536 },
            'McKinney Centre':             { match: /mckinney/i,  address: '222 McKinney Dr',     district: 'Whitby', postalCode: 'L1R 3M4', lat: 43.9036, lng: -78.9564 },
            'Fieldgate Sports Complex':    { match: /fieldgate/i, address: '2 Gathering Place',   district: 'Whitby', postalCode: '',        lat: 43.9568, lng: -78.9512 }
        },
        district: 'Whitby',
        unverified: true,      // a page of tables, no live feed
        infoUrl: 'https://www.whitby.ca/explore-and-enjoy/parks-and-recreation/skating-schedules-and-arenas/'
    },
    'uoft': {
        kind: 'uoft',
        // U of T Kinesiology & Physical Education, Varsity Arena: a weekly grid per term ("Varsity Centre -
        // Arena Fall Schedule - September 14 to December 6", Mon … Sun, cells "11:00am-12:50pm Skate") and,
        // around exams, grids with a date on each column ("Mon, Dec 7"; sometimes the month is left out).
        url: 'https://kpe.utoronto.ca/sport-recreationrecreational-fitness-drop-sportsdrop-sports-activities/drop-ice-skate-ice-sports',
        daysAhead: 28,
        paid: true,
        programs: [
            { match: /^skate$/i, activity: 'Recreational Skate' },
            { match: /^hockey$/i, activity: 'Drop-in Hockey' }
        ],
        priceNote: 'U of T members and students; anyone else needs a day pass from U of T Sport & Rec (family passes can be bought online). Skate rentals $6 + HST',
        locationName: 'Varsity Arena (U of T)',
        venues: {
            'Varsity Arena (U of T)': { address: '299 Bloor St W', district: 'Toronto and East York', postalCode: 'M5S 1W2', lat: 43.6670621, lng: -79.3961168 }
        },
        district: 'Toronto and East York',
        unverified: true,
        infoUrl: 'https://kpe.utoronto.ca/sport-recreationrecreational-fitness-drop-sportsdrop-sports-activities/drop-ice-skate-ice-sports'
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

/* ================= Our own network (v3.12.1) =================
 *
 * This runs on a home server on Wi-Fi, and that Wi-Fi goes away for a few seconds
 * several times a day (the access point changes channel, or the box's own watchdog
 * rejoins it). A run that was in the middle of its sources then failed every one
 * that was left within a second ("getaddrinfo ENOTFOUND" for seventeen hosts in a
 * row, twice in three weeks), and the app said seventeen sources were behind until
 * the next run. None of those sites had a problem: this machine did.
 *
 * So a failed read first asks whether this machine can get out at all. If it cannot,
 * the run waits for the network (two minutes at most, five minutes a run) and reads
 * the source again. A source that failed while the network was fine gets a second
 * try at the end of the run: most failures are one slow answer. And if several
 * unrelated sites still never answered, that is this machine again: what their last
 * read said stands, for up to three hours.
 */
const NET_ROUTE = [['1.1.1.1', 443], ['9.9.9.9', 443], ['8.8.8.8', 443]];   // by address: is there a way out (no name lookup involved)
const NET_NAMES = ['www.toronto.ca', 'github.com'];                         // by name: can names be looked up
const NET_WAIT_MS = 120000, NET_STEP_MS = 5000;
const NET_BUDGET = { leftMs: 5 * 60000 };          // the most one run may spend waiting for the network
const OFFLINE_KEEP_MS = 3 * 3600000;               // how long a last read may stand in for one this machine could not make
const SECOND_TRY_GAP_MS = 30000;                   // a failed read is tried again no sooner than this
const OURS_MIN_SOURCES = 4, OURS_MIN_SITES = 3;    // this many sources on this many unrelated sites, all silent: it is us
const NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EADDRNOTAVAIL', 'ECONNABORTED']);
const pause = (ms) => new Promise(r => setTimeout(r, ms));

/** Does a TCP connection to host:port open within `ms`? Never throws. */
function tcpOpens(host, port, ms = 4000) {
    return new Promise((resolve) => {
        const s = require('net').connect({ host, port });
        const done = (ok) => { s.destroy(); resolve(ok); };
        s.setTimeout(ms, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}
/** True as soon as one of the promises is true; false when none is (a rejection counts as false). */
const anyTrue = (promises) => new Promise((resolve) => {
    let left = promises.length;
    if (!left) return resolve(false);
    const no = () => { if (--left === 0) resolve(false); };
    promises.forEach(p => Promise.resolve(p).then(ok => (ok ? resolve(true) : no()), no));
});
/** Can this machine reach the internet: a route out (by address) and working name lookups. */
async function networkUp({ connect = tcpOpens, lookup = (name) => require('dns').promises.lookup(name) } = {}) {
    if (!(await anyTrue(NET_ROUTE.map(([h, p]) => connect(h, p))))) return false;
    return anyTrue(NET_NAMES.map(n => Promise.resolve().then(() => lookup(n)).then(() => true)));
}
/** Wait for the network to come back, checking every few seconds. → true when it did, false when the wait ran out. */
async function waitForNetwork({ up = networkUp, sleep = pause, now = Date.now, maxMs = NET_WAIT_MS, stepMs = NET_STEP_MS, budget = NET_BUDGET } = {}) {
    const t0 = now(), limit = Math.min(maxMs, budget.leftMs);
    let back = false;
    while (!back && now() - t0 < limit) {
        await sleep(stepMs);
        back = await up();
    }
    const waited = now() - t0;
    budget.leftMs = Math.max(0, budget.leftMs - waited);
    console.log(back ? `   📶 the network is back after about ${Math.round(waited / 1000)} s` : `   📡 still offline after ${Math.round(waited / 1000)} s`);
    return back;
}
/** Before a stage that needs the network: if this machine is offline, give it a moment to come back. */
async function settleNetwork(label, { up = networkUp, wait = waitForNetwork } = {}) {
    if (await up()) return true;
    console.warn(`📡 offline before ${label}: waiting for the network`);
    return wait();
}
/** What went wrong, in words. Node's "tried every address" error has no message of its own, only a code and a list. */
function errorText(e) {
    if (!e) return 'unknown error';
    if (typeof e === 'string') return e;
    if (e.message) return e.message;
    const inner = Array.isArray(e.errors) ? e.errors.map(x => x && (x.message || x.code)).filter(Boolean) : [];
    return [e.code, ...new Set(inner)].filter(Boolean).join(': ') || String(e);
}
/** Did the request never get an answer (a network matter, ours or theirs), as opposed to an answer that was no use? */
function neverAnswered(e) {
    if (!e || typeof e !== 'object') return false;
    const codes = [e.code, ...(Array.isArray(e.errors) ? e.errors.map(x => x && x.code) : [])];
    return codes.some(c => NET_CODES.has(c)) || /^Timeout for /.test(e.message || '');
}
/** The site a source lives on, as its last two name parts ("vaughan.perfectmind.com" → "perfectmind.com"): one service counts once. */
function sourceSite(cfg, message = '') {
    const m = /https?:\/\/([^/\s:?#]+)/.exec(message) || /getaddrinfo \S+ ([^\s:]+)/.exec(message);
    let host = m ? m[1] : '';
    if (!host) {
        for (const v of Object.values(cfg || {})) {
            if (typeof v !== 'string' || !/^https?:\/\//.test(v)) continue;
            try { host = new URL(v).hostname; break; } catch { /* not a URL after all */ }
        }
    }
    return host.toLowerCase().split('.').slice(-2).join('.');
}
/** A source this machine could not reach: what its last read recorded, with the rows that are still ahead. */
function keptResult(was, failed) {
    const out = { records: failed.records || [], kept: true, ok: was.ok !== false, state: was.state || (was.ok === false ? 'failed' : 'ok'), at: was.at };
    ['okAt', 'error', 'note', 'quote', 'season', 'opens', 'resumes', 'manual', 'edited'].forEach(k => { if (was[k]) out[k] = was[k]; });
    return out;
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

/** CKAN stamps are UTC without a zone ("2026-11-21T11:03:39.123456"): make them ISO, or null. */
function ckanStamp(s) {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(String(s || ''));
    return m ? `${m[1]}Z` : null;
}

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

/**
 * "McGREGOR PARK COMMUNITY CENTRE" → "McGregor Park Community Centre".
 * Shouty = four letters in five are capitals (the City's asset names keep a
 * lowercase c in "McGREGOR", so an all-caps test let it through); Mc names
 * and O'Names keep their inner capital, small words stay small.
 */
function titleCaseIfShouty(s) {
    if (!s) return '';
    // "Mccowan" → "McCowan" whatever the rest looks like (the City writes it both ways)
    const mc = (x) => x.replace(/\bMc([a-z])/g, (m, ch) => 'Mc' + ch.toUpperCase());
    const letters = s.replace(/[^A-Za-z]/g, '');
    if (letters.length < 4 || letters.replace(/[^A-Z]/g, '').length < letters.length * 0.8) return mc(s);
    const SMALL = new Set(['of', 'and', 'the', 'at', 'on', 'in', 'de', 'du', 'des', 'la', 'le']);
    return mc(s.toLowerCase()
        .replace(/(^|[\s\-\/('.])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase()))
        .replace(/\s([A-Z][a-z]+)\b/g, (m, w) => SMALL.has(w.toLowerCase()) ? ' ' + w.toLowerCase() : m);
}

/**
 * Fetch indoor + outdoor rink datasets and group pads by city locationid.
 * Gives the client: coordinates (nearest-rink locator), pad kinds
 * (indoor/outdoor — needed to judge whether a "Closed for the Season"
 * alert on the outdoor pad affects an indoor program), and the full rink
 * universe including rinks with no scheduled drop-ins.
 */
/**
 * City drop-in locations the rink datasets do not list (Scarborough Arena
 * Gardens, Park Lawn Park…) still deserve a pin and a count. Their address
 * comes from the program rows; coordinates via Nominatim, cached in
 * projects/data/geocode-cache.json so the lookup happens once per address.
 */
const GEOCODE_CACHE = path.join(OUTPUT_DIR, 'geocode-cache.json');
async function geocodeAddress(query) {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(GEOCODE_CACHE, 'utf8')); } catch { /* first run */ }
    const key = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (cache[key]) return cache[key];
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ca&q=${encodeURIComponent(query)}`;
    const arr = JSON.parse(await httpGetText(url, { Accept: 'application/json' }));
    await new Promise(r => setTimeout(r, 1100));   // Nominatim: at most one request per second
    if (!Array.isArray(arr) || !arr.length) return null;
    const hit = { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), label: arr[0].display_name };
    cache[key] = hit;
    fs.writeFileSync(GEOCODE_CACHE, JSON.stringify(cache, null, 1));
    return hit;
}

/** No outdoor rink in Toronto has ice between mid-April and mid-November. */
const inOutdoorLull = (ymd) => { const md = String(ymd || '').slice(5); return md >= '04-15' && md <= '11-14'; };
/** 'indoor' | 'outdoor' | null from the asset an alert is filed under ("Outdoor Artificial Ice Rink"). */
const assetKind = (a) => { const t = String(a && a.Type || '').toLowerCase(); return t.includes('outdoor') ? 'outdoor' : t.includes('indoor') ? 'indoor' : null; };

/**
 * What ice does a City location have when neither rink dataset lists it?
 * Until 2026-11 every such location was called indoor, which made eleven
 * Etobicoke park rinks and the North Toronto outdoor rink indoor arenas in
 * the rink list, the filters and the alert logic.
 *
 * Evidence, strongest first, and it is remembered (kindsSeen), because the
 * first kind is only visible while the City has an alert posted there:
 *   - the alert feed files a notice under an outdoor or an indoor rink asset
 *   - a session on a date when no outdoor rink has ice means indoor ice
 * With no evidence yet, the City's own location type decides: every park
 * the datasets do list has an outdoor rink (36 of 36), everything else is
 * most often an arena or a community centre with indoor ice.
 * A location can have both.
 */
function inferKinds({ locationType, feedKinds = [], lullSession = false, kindsSeen = [] } = {}) {
    const seen = new Set([...(kindsSeen || []), ...feedKinds]);
    if (lullSession) seen.add('indoor');
    const remembered = ['indoor', 'outdoor'].filter(k => seen.has(k));
    const kinds = remembered.length ? remembered : [/park|outdoor/i.test(String(locationType || '')) ? 'outdoor' : 'indoor'];
    return { kinds, kindsSeen: remembered };
}

/**
 * What a seasonal source's last read says about one of its rinks, for rinks.json:
 * { state: 'ok' | 'pending' | 'closed' | 'shut' | 'dormant' | 'failed', from?, to?, opens?, quote? }, or null for a
 * year-round source. On a multi-rink page each rink follows its own row. Pure.
 */
function rinkSeasonal(cfg, s, venueKeyName = null) {
    if (!cfg || !cfg.season || !s) return null;
    const out = { state: s.state };
    if (s.season && s.season.from) out.from = s.season.from;
    if (s.season && s.season.to) out.to = s.season.to;
    if (s.opens) out.opens = s.opens;
    if (s.quote) out.quote = s.quote;
    if (venueKeyName && Array.isArray(s.venues)) {
        const row = s.venues.find(v => v.key === venueKeyName);
        if (row) {
            // open; shut for now ("Ice conditions"); or out for the season, which before opening day reads "not open yet"
            const seasonal = /season/i.test(row.reason || '');
            const soon = /\bopen(?:ing|s)?\b[^.]*\bsoon\b|\bwill\s+(?:re-?)?open\b/i.test(s.quote || '');
            out.state = rowIsOpen(row) ? 'ok' : !seasonal ? 'shut' : (soon || s.state === 'pending') ? 'pending' : 'closed';
            out.quote = [row.status, row.reason].filter(x => x && !/^[\s\u200b-]*$/.test(x)).join(': ');
        }
    }
    return out;
}

async function fetchRinkInventory(programs = [], external = null) {
    const byLocation = {};
    // v3.12: how a seasonal source's last read went, for the rink list ("opens Dec 12", "closed for the season")
    let wasSeasonal = null;      // rink id → what the last rink list said, read only if a source was not reached this run
    const seasonalOf = (key, cfg, venueKeyName, locId) => {
        const s = external && external[key];
        if (s && s.kept && cfg && cfg.season) {
            if (!wasSeasonal) {
                wasSeasonal = new Map();
                try { (JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'rinks.json'), 'utf8')).rinks || []).forEach(r => { if (r.seasonal) wasSeasonal.set(String(r.locationid), r.seasonal); }); } catch { /* no earlier list */ }
            }
            if (wasSeasonal.has(String(locId))) return wasSeasonal.get(String(locId));
        }
        return rinkSeasonal(cfg, s, venueKeyName);
    };

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
            (entry.padsBy ||= {})[pkg.kind] = (entry.padsBy[pkg.kind] || 0) + 1;
            if (!entry.kinds.includes(pkg.kind)) entry.kinds.push(pkg.kind);
            if (entry.lat == null && lat != null) { entry.lat = lat; entry.lng = lng; }
        });
    }

    // External sources join the same universe (locator + calendar need them).
    Object.entries(EXTERNAL_SOURCES).forEach(([key, cfg]) => {
        // A page that is only watched (no public skating there) adds nothing but the arena's own site.
        if (cfg.kind === 'watch') {
            const existing = cfg.locationId ? byLocation[String(cfg.locationId)] : null;
            if (existing && !existing.website) existing.website = cfg.infoUrl;
            return;
        }
        // Multi-venue sources (PerfectMind calendars, Brampton's outdoor table) emit ONE entry
        // per configured venue, keyed like the program records' ExtLocationKey.
        const venueTable = cfg.venues
            ? { ...(discoveredVenues[key] || {}), ...cfg.venues }
            : cfg.venueList ? Object.fromEntries(cfg.venueList.map(v => [v.name, v])) : null;
        if (venueTable) {
            Object.entries(venueTable).forEach(([name, v]) => {
                const locId = venueKey(key, name);
                const seasonal = seasonalOf(key, cfg, locId, locId);
                byLocation[locId] = {
                    locationid: locId,
                    name,
                    address: v.address || '',
                    postal: v.postalCode || '',
                    district: v.district || cfg.defaultDistrict || '',
                    lat: v.lat ?? null, lng: v.lng ?? null,
                    kinds: [...(cfg.kinds || ['indoor'])],
                    pads: 1,
                    operator: 'External',
                    source: 'external',
                    externalSource: key,
                    website: cfg.infoUrl,
                    paid: !!cfg.paid,
                    // one page describes sixteen rinks, and says rentals are at two of them: not a page to read rink facts from
                    ...(cfg.venueList ? { noFacts: true } : {}),
                    ...(seasonal ? { seasonal } : {})
                };
            });
            return;
        }

        const locId = cfg.locationId ? String(cfg.locationId) : `ext-${key}`;
        const existing = byLocation[locId];
        const seasonal = seasonalOf(key, cfg, null, locId);
        if (existing) {
            // City already lists it (e.g. Moss Park) — just mark the external link.
            existing.website = cfg.infoUrl;
            existing.externalSource = key;
            if (cfg.paid) existing.paid = true;
            if (seasonal) existing.seasonal = seasonal;
        } else {
            byLocation[locId] = {
                locationid: locId,
                name: cfg.locationName,
                address: cfg.address,
                postal: cfg.postalCode || '',
                district: cfg.district || '',
                lat: cfg.lat, lng: cfg.lng,
                kinds: [...(cfg.kinds || ['indoor'])],
                pads: cfg.resourceIds ? cfg.resourceIds.length : 1,
                operator: 'External',
                source: 'external',
                externalSource: key,
                website: cfg.infoUrl,
                paid: !!cfg.paid,
                ...(seasonal ? { seasonal } : {})
            };
        }
    });

    // City locations that only exist in the program rows
    const missing = {};
    const lullSession = new Set();   // locations with a session while no outdoor rink has ice
    programs.forEach(p => {
        if (p.Source && p.Source !== 'city') return;
        const id = p['Location ID'];
        if (id == null || byLocation[String(id)]) return;
        if (inOutdoorLull(String(p['Start Date'] || '').slice(0, 10))) lullSession.add(String(id));
        if (missing[id] || !p.LocationName) return;
        missing[id] = p;
    });
    // what we knew last run: the kinds each of these locations has shown, and the City's own asset types in the alert feed
    const seenBefore = {}, feedKinds = {};
    try {
        (JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'rinks.json'), 'utf8')).rinks || [])
            .forEach(r => { if (Array.isArray(r.kindsSeen)) seenBefore[String(r.locationid)] = r.kindsSeen; });
    } catch { /* first run */ }
    try {
        (JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'alerts.json'), 'utf8')).alerts || []).forEach(a => {
            const k = assetKind(a);
            if (k) (feedKinds[String(a.LocationID)] ||= new Set()).add(k);
        });
    } catch { /* first run */ }
    for (const [id, p] of Object.entries(missing)) {
        let geo = null;
        try {
            geo = await geocodeAddress(`${p.Address ? p.Address + ', ' : ''}Toronto, ON${p.PostalCode ? ' ' + p.PostalCode : ''}`)
               || await geocodeAddress(`${p.LocationName}, Toronto, ON`);
        } catch (e) {
            console.warn(`   📍 geocode failed for ${p.LocationName}: ${e.message}`);
        }
        const ice = inferKinds({
            locationType: p.LocationType,
            feedKinds: [...(feedKinds[String(id)] || [])],
            lullSession: lullSession.has(String(id)),
            kindsSeen: seenBefore[String(id)]
        });
        byLocation[String(id)] = {
            locationid: String(id),
            name: p.LocationName,
            address: p.Address || '',
            postal: p.PostalCode || '',
            district: p.District || '',
            lat: geo ? geo.lat : null, lng: geo ? geo.lng : null,
            kinds: ice.kinds,
            ...(ice.kindsSeen.length ? { kindsSeen: ice.kindsSeen } : {}),
            pads: 1,
            operator: 'City of Toronto',
            source: 'city',
            fromPrograms: true
        };
        console.log(`   📍 added ${p.LocationName} (${id}) from the program rows as ${ice.kinds.join(' + ')}${geo ? '' : ' (no coordinates yet)'}`);
    }

    const before = Object.keys(byLocation).length;
    const folded = foldTwinRinks(Object.values(byLocation), programs);
    if (folded.length !== before) console.log(`   🧩 ${before - folded.length} rink${before - folded.length === 1 ? '' : 's'} the City lists twice folded into the entry its sessions use`);
    return folded.sort((a, b) => a.name.localeCompare(b.name));
}

/* ================= Service alerts → alerts.json ================= */

/**
 * Snapshot toronto.ca live skate alerts. Only writes the file when alert
 * CONTENT changed, so the 30-min CI tick doesn't spam commits.
 * Returns { changed, count }.
 */
/**
 * The skate feed only carries rink-asset alerts. Facility-wide notices
 * ("Unplanned Closure" of the whole centre, Type "Centre") live in each
 * location's own feed, /locations/<id>/alerts.json — that is where
 * toronto.ca's "Closures" box on a rink page comes from (Don Montgomery,
 * 2026-09-16: a Centre closure AND a rink alert, both about Rink 1).
 * Fetched for every City location that has skating sessions, kept when
 * they concern the building or the ice, tagged Scope: 'facility'.
 */
const LOC_ALERTS_URL = (id) => `https://www.toronto.ca/data/parks/live/locations/${id}/alerts.json`;
const FACILITY_TYPE_RE = /centre|center|arena|facility|building|rink|skat/i;
const NON_ICE_ASSET_RE = /pool|swim|gym|fitness|weight|track|field|court|tennis|sauna|studio|splash|wading|library|daycare|camp/i;
// A building notice earns a place on a skating card when it is about the
// ice, the building as a whole, or a building-wide condition. A spa, gym,
// pool or parking notice does not (unless it also mentions the ice).
const ABOUT_ICE_RE = /rink|\bice\b|skat|arena/i;
const ABOUT_BUILDING_RE = /(centre|center|facility|building|arena|site)\s+(is|will be|remains|are)?\s*(closed|closing|closure)|no (hot )?water|power (outage|failure)|\bheat(ing)?\b|temperature|hvac|roof|evacuat|flood/i;
const AMENITY_RE = /\bspa\b|sauna|gym\b|gymnasium|pool|parking|washroom|change\s*room|mezzanine|fitness|weight room|track|court|tennis|library|daycare|camp\b|table tennis/i;
async function fetchFacilityAlerts(locIds) {
    const out = [];
    const ids = [...new Set(locIds.map(String).filter(x => /^\d+$/.test(x)))];
    let failed = 0;
    for (let i = 0; i < ids.length; i += 6) {
        await Promise.all(ids.slice(i, i + 6).map(async (id) => {
            try {
                const raw = await fetchJSON(LOC_ALERTS_URL(id));
                const list = raw?.locations?.[`id_${id}`] || [];
                list.forEach(a => {
                    if (!a || a.Status == null) return;
                    const where = `${a.Type || ''} ${a.Category || ''} ${a.DisplayAlertName || ''}`;
                    const text = `${a.Reason || ''} ${a.Comments || ''}`;
                    const aboutIce = ABOUT_ICE_RE.test(text);
                    if (!FACILITY_TYPE_RE.test(where) && !aboutIce) return;          // gyms, pools, camps: not ours
                    if (NON_ICE_ASSET_RE.test(where) && !aboutIce) return;
                    if (!aboutIce && !ABOUT_BUILDING_RE.test(text)) return;          // a spa or gym notice is not a skating alert
                    if (!aboutIce && AMENITY_RE.test(text) && !ABOUT_BUILDING_RE.test(text)) return;
                    const facility = /centre|center|arena|facility|building/i.test(`${a.Type || ''} ${a.DisplayAlertName || ''}`) && !/rink/i.test(a.Type || '');
                    out.push({
                        LocationID: Number(a.locationid ?? a.LocationID ?? id),
                        AssetID: a.AssetID ?? null,
                        AssetName: a.AssetName || '',
                        Reason: a.Reason || '',
                        Comments: a.Comments || '',
                        Status: a.Status,
                        Category: a.Category || '',
                        Type: a.Type || '',
                        DisplayAlertName: a.DisplayAlertName || '',
                        PostedDate: a.PostedDate || '',
                        Scope: facility ? 'facility' : 'asset'
                    });
                });
            } catch (e) { failed++; }
        }));
    }
    console.log(`   facility feeds: ${ids.length} locations, ${out.length} kept, ${failed} failed`);
    return out;
}

/* ================= Alert reading → alerts[].Read ================= */

/**
 * Staff write alerts by hand, and word rules kept misreading them: on
 * 2026-11-11 a washroom notice that named a room "Upper Ice Galaxy" was
 * shown as a closed pad, and "Arenas both are closed till further notice"
 * was shown as a mild warning. So every alert with real sentences is read
 * ONCE by a model into fixed fields, the answer is checked against the
 * alert's own words, and the verified reading rides inside alerts.json as
 * `Read`. The app prefers it and keeps its word rules as the floor.
 *
 * Tiers, in order; the first whose answer verifies wins:
 *   1. Anthropic API (key in ALERT_READER_ANTHROPIC_KEY or the credentials file).
 *      It runs on a fixed credit. When that is spent, or the key lapses, this
 *      tier backs off and everything below carries on; nothing needs doing.
 *   2. the local Ollama model, only when ALERT_READER_LOCAL=1 (OLLAMA_URL): meaning
 *      only, its dates are not trusted. Off by default: on the 2026 corpus the small
 *      model read a roof leak as a closed rink, and a wrong closure is worse than the
 *      plain yellow alert the word rules give when they cannot tell
 *   3. readings another producer already published (ALERT_READINGS_URL): how the
 *      GitHub cron reuses the home server's work without holding a key
 *   4. nothing: the alert ships without a reading and the app's word rules decide.
 *      This is the main fallback, the same rules the app has always had.
 * (A second paid route through OpenRouter was written on 2026-11-11 and removed
 * the next day unused: one fixed credit, then the word rules, is the whole plan.)
 *
 * Nothing here can fail the run, and a model can never make an alert say
 * more than its text: the evidence must be a verbatim quote, dates and
 * times must be backed by the words, and the City's own closed flag is
 * never read down to "skating as usual".
 *
 * Spend guards: one call per distinct alert text (the cache is keyed by
 * content, so one notice pasted on forty rinks is one call), a cap per day
 * and per run, an hour's back-off after a key or billing error, and an
 * alert no tier could read is retried once a day, three times at most.
 */
const READER_VERSION = 1;                    // bump to re-read everything; the app ignores readings of another version
const READER_MODEL = process.env.ALERT_READER_MODEL || 'claude-haiku-5-5';
const READER_DAILY_CAP = Math.max(0, Number(process.env.ALERT_READER_DAILY_CAP ?? 80));   // paid calls per Toronto day
const READER_RUN_CAP = 25;                   // paid calls per run
const READER_LOCAL_RUN_CAP = 12;             // local-model calls per run (about 3 s each)
const READER_RETRY_MS = 24 * 3600 * 1000;
const READER_KEEP_DAYS = 45;                 // readings of alerts gone from the feed this long are dropped
const READINGS_FILE = path.join(OUTPUT_DIR, 'alert-readings.json');
const READINGS_URL = process.env.ALERT_READINGS_URL ?? 'https://skate-data.ronishbhatt.com/projects/data/alert-readings.json';
const READER_SKATING = ['off', 'one_pad_off', 'reduced', 'on'];
const READER_ABOUT = ['ice', 'building', 'amenity', 'sessions', 'other'];

// Tried on every alert the feed carried from July to November 2026 that had real
// sentences (35 of 96): Haiku 5.5 got the meaning of all 35 right. Change the
// wording only with skate/tests/unit/alert-corpus.json to hand, then bump READER_VERSION.
const READER_SYSTEM = `You read service alerts that City of Toronto recreation staff post about rinks, arenas and community centres, and report what each one means for a person planning to go skating at that location. Staff write quickly and in their own words, so judge by meaning, not by keywords. The name of a room or area inside a building can contain words like "ice" or "rink" without the alert being about the ice.

You are given the location and how many ice pads it has, the asset the alert is filed under, the City's status and reason label, the day it was posted, and the alert text.

Answer with these fields.

skating: what the alert means for public skating at this location while it applies.
  "off"          no skating there: the rink, arena, ice or whole building is closed, is not open yet, or all skating is cancelled
  "one_pad_off"  the location has more than one ice pad and only some of them are closed, so skating continues on the rest
  "reduced"      skating continues, but hours are shorter or some sessions are cancelled, and the text does not pin down which hours
  "on"           skating is not affected: the alert is about washrooms, change rooms, parking, an elevator, heating, a viewing area, a pool, a gym, construction that does not close the rink, and the like

about: the main thing the alert concerns. One of "ice", "building", "amenity", "sessions", "other".

starts: the first calendar day the disruption applies, as YYYY-MM-DD. Use the posting date unless the text names a later start.
ends: the last calendar day the disruption applies, as YYYY-MM-DD, or null when the text gives no end. When the text names a reopening day or an opening day, the disruption ends the day before it. "Today" and "tonight" mean the posting date. Work out "tomorrow" and weekday names from the posting date. "Until further notice", "check back for updates" and "for the season" give no end.

time_from, time_to: when the text limits the disruption to part of a day, the 24-hour clock times it covers, as HH:MM. Otherwise null. "Closed until 2 pm today" is time_to 14:00 with time_from null. "Leisure skate from 11:30am to 1:30pm is cancelled" is skating "off" with time_from 11:30 and time_to 13:30.

seasonal: true when the alert says the rink is closed for the season or for the rest of the season. Otherwise false.

evidence: the shortest exact quote from the alert text that justifies your "skating" answer. Copy it character for character.`;

const READER_SCHEMA = {
    type: 'object',
    properties: {
        skating: { type: 'string', enum: READER_SKATING },
        about: { type: 'string', enum: READER_ABOUT },
        starts: { type: ['string', 'null'] },
        ends: { type: ['string', 'null'] },
        time_from: { type: ['string', 'null'] },
        time_to: { type: ['string', 'null'] },
        seasonal: { type: 'boolean' },
        evidence: { type: 'string' }
    },
    required: ['skating', 'about', 'starts', 'ends', 'time_from', 'time_to', 'seasonal', 'evidence'],
    additionalProperties: false
};

/**
 * Keys for the paid tiers: env vars, or one small file in any layout, since
 * each key is recognised by its shape. The file is ALERT_READER_CREDENTIALS, or
 * the systemd credential "alert-reader" on the home server. The standard
 * ANTHROPIC_API_KEY is deliberately not read here, so wiring this stage up
 * cannot switch on the older schedule fallback (llmParseSchedule) and its own
 * spending.
 */
function readerCreds() {
    let blob = '';
    const file = process.env.ALERT_READER_CREDENTIALS
        || (process.env.CREDENTIALS_DIRECTORY ? path.join(process.env.CREDENTIALS_DIRECTORY, 'alert-reader') : '');
    if (file) { try { blob = fs.readFileSync(file, 'utf8'); } catch { /* optional */ } }
    const pick = (re) => (blob.match(re) || [])[0] || '';
    return {
        anthropicKey: process.env.ALERT_READER_ANTHROPIC_KEY || pick(/sk-ant-[A-Za-z0-9_-]{20,}/),
        anthropicWorkspace: process.env.ALERT_READER_ANTHROPIC_WORKSPACE || pick(/wrkspc_[A-Za-z0-9]{6,}/)
    };
}

/** Never let a key reach a log line or a published file, whatever an error message echoes back. */
const readerScrub = (s) => String(s || '').replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…').replace(/wrkspc_[A-Za-z0-9]+/g, 'wrkspc_…').slice(0, 180);

class ReaderError extends Error {
    constructor(kind, message) { super(readerScrub(message)); this.kind = kind; }
}
/** auth and billing need a human; rate and server pass by themselves; request means our call is wrong. */
const readerErrorKind = (status, message) =>
    status === 401 || status === 403 ? 'auth'
    : status === 402 || /credit balance|insufficient credits|billing/i.test(message || '') ? 'billing'
    : status === 429 ? 'rate'
    : status >= 500 ? 'server'
    : status >= 400 ? 'request'
    : 'answer';

/** POST JSON and keep the status code (postText below drops it). */
function postStatus(url, body, headers, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'http:' ? require('http') : https;
        const req = mod.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => resolve({ status: r.statusCode || 0, text: d }));
            r.on('error', (e) => reject(new ReaderError('network', e.message)));
        });
        req.on('error', (e) => reject(new ReaderError('network', e.message)));
        req.setTimeout(timeoutMs, () => req.destroy(new ReaderError('network', 'timeout')));
        req.write(body); req.end();
    });
}

const readerClean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
/** Only alerts with real sentences go to a model; a bare status ("Closed for the Season", no text) needs no reading. */
const readerWants = (a) => readerClean(a.Comments).split(' ').filter(Boolean).length >= 4;

/** One reading per distinct notice: the same words under the same status, posted the same day, at a rink with one pad or several. */
function readerKey(a, multiPad) {
    return crypto.createHash('sha1').update([
        READER_VERSION, String(a.Status), a.Scope || 'asset', a.Type || '', a.Reason || '',
        readerClean(a.Comments), String(a.PostedDate || '').slice(0, 10), multiPad ? 'multi' : 'single'
    ].join('\n')).digest('hex').slice(0, 20);
}

function readerUserMessage(a, rink) {
    const posted = String(a.PostedDate || '').slice(0, 10);
    const t = Date.parse(posted + 'T12:00:00Z');
    const postedLine = Number.isNaN(t) ? (posted || 'unknown')
        : `${new Date(t).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} ${posted}`;
    const n = rink ? (rink.pads || 1) : 1;
    const where = rink
        ? `${rink.name} (${n} ice pad${n !== 1 ? 's' : ''}, ${(rink.kinds || []).join(' and ') || 'kind unknown'})`
        : '(not in our rink list)';
    return [
        `Location: ${where}`,
        `Filed under: ${a.AssetName || '(none)'}${a.Type ? ` [${a.Type}]` : ''}`,
        `City status: ${String(a.Status) === '0' ? 'the City marks this asset closed' : 'service alert'}`,
        `Reason label: ${a.Reason || '(none)'}`,
        `Posted: ${postedLine}`,
        `Text: ${readerClean(a.Comments) || '(no text)'}`
    ].join('\n');
}

const READER_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ymdOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s + 'T12:00:00Z'));
const ymdAdd = (ymd, n) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const ymdDiff = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);

/**
 * Is this date backed by the alert's own words? It is when the text names it
 * (or the day after it, for "re-opening on …"), when it is the posting day,
 * when a relative word ("tomorrow", "Friday") or a stated span ("for two
 * weeks", "the week of …") can reach it from there.
 */
function readerDateBacked(ymd, low, posted) {
    const named = (d) => new RegExp(`\\b${READER_MONTHS[+d.slice(5, 7) - 1]}[a-z]*\\.?\\s+0?${+d.slice(8, 10)}(?!\\d)`).test(low);
    if (named(ymd) || named(ymdAdd(ymd, 1))) return true;
    if (/\bweek\b/.test(low)) { for (let k = 1; k <= 7; k++) if (named(ymdAdd(ymd, -k))) return true; }
    if (!posted) return false;
    if (ymd === posted) return true;
    const gap = Math.abs(ymdDiff(posted, ymd));
    if (gap <= 8 && /\b(?:today|tonight|tomorrow|this (?:morning|afternoon|evening|week|weekend)|next week|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/.test(low)) return true;
    return gap <= 100 && /\b(?:for|next|within|about|approximately)\s+(?:the\s+)?(?:next\s+)?(?:\d+|a|one|two|three|four|five|six|a few|several)\s+(?:days?|weeks?|months?)\b/.test(low);
}

/** Every clock time the text mentions, as minutes of the day ("2 pm", "11:30am", "13:30", "noon"). */
function readerTimesIn(low) {
    const set = new Set();
    let m;
    const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/g;
    while ((m = ampm.exec(low))) set.add(((+m[1] % 12) + (m[3][0] === 'p' ? 12 : 0)) * 60 + +(m[2] || 0));
    const bare = /\b(\d{1,2}):(\d{2})\b/g;
    while ((m = bare.exec(low))) {
        const h = +m[1], mi = +m[2];
        if (h < 24 && mi < 60) { set.add(h * 60 + mi); if (h < 12) set.add((h + 12) * 60 + mi); }
    }
    if (/\bnoon\b/.test(low)) set.add(720);
    if (/\bmidnight\b/.test(low)) set.add(0);
    return set;
}

/**
 * A model's answer becomes a reading only if the alert's own words back it.
 * → { ok: true, read, quote } or { ok: false, why }
 */
function verifyReading(a, rink, out, { by = 'model', trustDates = true } = {}) {
    if (!out || typeof out !== 'object') return { ok: false, why: 'no answer' };
    if (!READER_SKATING.includes(out.skating)) return { ok: false, why: 'skating value not in the list' };
    const text = readerClean(a.Comments);
    const quote = normQuote(out.evidence);
    if (quote.length < 4 || !normQuote(`${text} ${a.Reason || ''} ${a.AssetName || ''}`).includes(quote)) return { ok: false, why: 'evidence is not a quote from the alert' };
    // Status 0 on an asset is the City's own closed flag (a building notice carries the field loosely)
    if (out.skating === 'on' && a.Scope !== 'facility' && String(a.Status) === '0') return { ok: false, why: 'says skating is unaffected while the City marks the asset closed' };

    const low = `${text} ${a.Reason || ''}`.toLowerCase();
    const posted = ymdOk(String(a.PostedDate || '').slice(0, 10)) ? String(a.PostedDate).slice(0, 10) : null;
    const read = {
        v: READER_VERSION,
        skating: out.skating,
        about: READER_ABOUT.includes(out.about) ? out.about : 'other',
        starts: null, ends: null, timeFrom: null, timeTo: null,
        seasonal: !!out.seasonal && /season|winter|summer/.test(low),
        by
    };
    // one pad of one is the rink (pad counts are real for rinks the City's datasets list)
    if (read.skating === 'one_pad_off' && rink && !rink.fromPrograms && !(rink.pads > 1)) read.skating = 'off';

    if (!trustDates) { read.dates = 'rules'; return { ok: true, read, quote: cleanQuote(out.evidence) }; }

    // A date the words do not back is dropped, never guessed: no start means "from the posting day",
    // no end means "while the City leaves it up".
    const inRange = (d) => ymdOk(d) && (!posted || (ymdDiff(posted, d) >= -2 && ymdDiff(posted, d) <= 400));
    if (inRange(out.starts) && readerDateBacked(out.starts, low, posted)) read.starts = out.starts;
    if (inRange(out.ends) && readerDateBacked(out.ends, low, posted)) read.ends = out.ends;
    if (read.starts && read.ends && read.ends < read.starts) { read.starts = null; read.ends = null; }
    if (posted && read.ends && read.ends < posted && !read.starts) read.ends = null;

    // a part-of-day window only when both clock times are in the text; otherwise the whole day stands
    const hm = (s) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(s || '') ? s : null);
    const tf = hm(out.time_from), tt = hm(out.time_to);
    if (tf || tt) {
        const mentioned = readerTimesIn(low);
        const mins = (s) => +s.slice(0, 2) * 60 + +s.slice(3);
        if ((!tf || mentioned.has(mins(tf))) && (!tt || mentioned.has(mins(tt))) && (!tf || !tt || mins(tf) < mins(tt))) { read.timeFrom = tf; read.timeTo = tt; }
    }
    return { ok: true, read, quote: cleanQuote(out.evidence) };
}

/** Parse a tier's JSON answer or name what went wrong. */
function readerParse(text) {
    try { return JSON.parse(String(text || '').replace(/^```(?:json)?\s*|```\s*$/g, '').trim()); }
    catch { throw new ReaderError('answer', 'the answer was not JSON'); }
}

async function readWithAnthropic(creds, userMsg) {
    const headers = { authorization: `Bearer ${creds.anthropicKey}`, 'anthropic-version': '2026-10-21' };
    // a key that is not tied to one workspace must say which workspace the call belongs to
    if (creds.anthropicWorkspace) headers['anthropic-workspace-id'] = creds.anthropicWorkspace;
    const { status, text } = await postStatus('https://api.anthropic.com/v1/messages', JSON.stringify({
        model: READER_MODEL,
        max_tokens: 2048,
        system: READER_SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
        output_config: { format: { type: 'json_schema', schema: READER_SCHEMA } }
    }), headers);
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON: handled below */ }
    if (status !== 200 || !body) throw new ReaderError(readerErrorKind(status, body?.error?.message), `HTTP ${status} ${body?.error?.type || ''} ${body?.error?.message || ''}`);
    // a refusal or a cut-off answer is not a reading
    if (body.stop_reason !== 'end_turn') throw new ReaderError('answer', `stopped with ${body.stop_reason}`);
    const block = (body.content || []).find(b => b.type === 'text');
    return { out: readerParse(block && block.text), usage: { in: body.usage?.input_tokens, out: body.usage?.output_tokens } };
}

async function readWithOllama(ollama, userMsg) {
    let res;
    try {
        res = JSON.parse(await postText(`${ollama}/api/chat`, JSON.stringify({
            model: FACTS_MODEL(), stream: false, think: false, format: READER_SCHEMA,
            options: { temperature: 0, num_ctx: 4096 },
            messages: [{ role: 'system', content: READER_SYSTEM }, { role: 'user', content: userMsg }]
        }), {}, 120000));
    } catch (e) { throw new ReaderError('network', e.message); }
    if (res.error) throw new ReaderError('server', res.error);
    return { out: readerParse(res.message?.content), usage: { in: res.prompt_eval_count, out: res.eval_count } };
}

/** The tiers this run can use, best first. */
function readerTiers(creds = readerCreds()) {
    const ollama = (process.env.OLLAMA_URL || '').replace(/\/+$/, '');
    const tiers = [];
    if (creds.anthropicKey) tiers.push({ name: 'anthropic', by: READER_MODEL, paid: true, trustDates: true, call: (msg) => readWithAnthropic(creds, msg) });
    // opt-in: the small local model reads meaning well and dates badly (33 of 35 and 3 of 15 on the 2026 corpus); the app's rules date its readings
    if (ollama && process.env.ALERT_READER_LOCAL === '1') tiers.push({ name: 'local', by: FACTS_MODEL(), paid: false, trustDates: false, call: (msg) => readWithOllama(ollama, msg) });
    return tiers;
}

/**
 * Attach a verified reading to every alert that has one (mutates `alerts`).
 * → the summary the app shows in its freshness menu: { v, by, read, rules, waiting, error }
 */
async function readAlerts(alerts, rinks) {
    if (!Array.isArray(rinks) || !rinks.length) {
        try { rinks = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'rinks.json'), 'utf8')).rinks || []; } catch { rinks = []; }
    }
    const rinkBy = Object.fromEntries(rinks.map(r => [String(r.locationid), r]));
    const rinkOf = (a) => rinkBy[String(a.LocationID)] || null;
    const keyOf = (a) => { const r = rinkOf(a); return readerKey(a, !!(r && r.pads > 1)); };
    const tiers = readerTiers();
    const today = torontoDateStr();
    const now = Date.now();
    const stamp = () => new Date().toISOString();

    let cache = { v: READER_VERSION, day: today, calls: 0, backoff: {}, readings: {} };
    try {
        const c = JSON.parse(fs.readFileSync(READINGS_FILE, 'utf8'));
        if (c && c.v === READER_VERSION && c.readings) cache = { ...cache, ...c, backoff: c.backoff || {}, readings: c.readings };
    } catch { /* first run */ }
    let dirty = false;
    if (cache.day !== today) { cache.day = today; cache.calls = 0; dirty = true; }

    const wanted = alerts.filter(readerWants);
    // longest first: if a cap bites, the notices with the most to misread have been read
    const order = [...wanted].sort((x, y) => readerClean(y.Comments).length - readerClean(x.Comments).length);
    const down = new Set();     // tiers out for the rest of this run
    let runPaid = 0, runLocal = 0, fresh = 0, lastError = null;
    const done = new Set();

    for (const a of order) {
        const key = keyOf(a);
        if (done.has(key)) continue;
        done.add(key);
        const had = cache.readings[key];
        if (had) {
            if (had.seenDay !== today) { had.seenDay = today; dirty = true; }
            if (had.read) continue;
            if (had.fail && ((had.tries || 0) >= 3 || now - Date.parse(had.at) < READER_RETRY_MS)) continue;
        }
        const msg = readerUserMessage(a, rinkOf(a));
        let failWhy = null;
        for (const t of tiers) {
            const off = cache.backoff[t.name];
            if (down.has(t.name) || (off && off.until > now)) continue;
            if (t.paid && (cache.calls >= READER_DAILY_CAP || runPaid >= READER_RUN_CAP)) continue;
            if (!t.paid && runLocal >= READER_LOCAL_RUN_CAP) continue;
            if (t.paid) { cache.calls++; runPaid++; } else runLocal++;
            dirty = true;
            try {
                const { out } = await t.call(msg);
                if (cache.backoff[t.name]) delete cache.backoff[t.name];
                const v = verifyReading(a, rinkOf(a), out, { by: t.by, trustDates: t.trustDates });
                if (v.ok) { cache.readings[key] = { read: v.read, quote: v.quote, at: stamp(), seenDay: today }; fresh++; failWhy = null; break; }
                failWhy = `${t.name}: ${v.why}`;
            } catch (e) {
                const kind = e.kind || 'answer';
                console.warn(`   🧠 ${t.name} could not read an alert (${kind}: ${readerScrub(e.message)})`);
                if (kind === 'answer') { failWhy = `${t.name}: ${readerScrub(e.message)}`; continue; }
                lastError = `${t.name}: ${kind}`;
                down.add(t.name);
                // a bad key, an empty balance or a malformed call will not fix itself in ten minutes
                if (kind === 'auth' || kind === 'billing' || kind === 'request') cache.backoff[t.name] = { until: now + (kind === 'billing' ? 6 : 1) * 3600 * 1000, error: kind, at: stamp() };
            }
        }
        if (failWhy) cache.readings[key] = { fail: failWhy, at: stamp(), tries: ((had && had.tries) || 0) + 1, seenDay: today };
    }

    // Without a tier of our own (the GitHub cron), borrow what the home server already read.
    let borrowed = {};
    const stillWaiting = wanted.filter(a => !cache.readings[keyOf(a)]);
    if (!tiers.length && stillWaiting.length && READINGS_URL) {
        try {
            const remote = await fetchJSON(READINGS_URL);
            if (remote && remote.v === READER_VERSION && remote.readings) borrowed = remote.readings;
        } catch (e) { console.warn(`   🧠 no published readings to borrow (${e.message})`); }
    }

    // forget readings of alerts long gone from the feed
    const keepFrom = ymdAdd(today, -READER_KEEP_DAYS);
    for (const [k, e] of Object.entries(cache.readings)) {
        if ((e.seenDay || String(e.at || '').slice(0, 10)) < keepFrom) { delete cache.readings[k]; dirty = true; }
    }

    const stats = { read: 0, rules: 0, waiting: 0 };
    const by = new Set();
    for (const a of alerts) {
        delete a.Read;
        if (!readerWants(a)) { stats.rules++; continue; }
        const key = keyOf(a);
        const own = cache.readings[key];
        let read = own && own.read;
        if (!read && borrowed[key] && borrowed[key].read) {
            // same checks as a fresh answer: a borrowed reading must still quote this alert
            const b = borrowed[key];
            const again = verifyReading(a, rinkOf(a), { ...b.read, evidence: b.quote, time_from: b.read.timeFrom, time_to: b.read.timeTo }, { by: b.read.by, trustDates: b.read.dates !== 'rules' });
            if (again.ok) read = again.read;
        }
        if (read) { a.Read = read; stats.read++; by.add(read.by); }
        else if ((own && own.fail) || !tiers.length) stats.rules++;   // no tier here will ever read it: the word rules have it
        else stats.waiting++;
    }

    if (dirty && tiers.length) {
        try { fs.writeFileSync(READINGS_FILE, JSON.stringify(cache)); }
        catch (e) { console.warn(`   🧠 could not save the readings cache: ${e.message}`); }
    }
    const held = Object.entries(cache.backoff).filter(([, b]) => b.until > now).map(([n, b]) => `${n}: ${b.error}`)[0] || null;
    const summary = {
        v: READER_VERSION,
        by: [...by].sort().join(', ') || (tiers[0] ? tiers[0].by : 'word rules'),
        read: stats.read, rules: stats.rules, waiting: stats.waiting,
        error: lastError || held
    };
    console.log(`   🧠 alert reader: ${stats.read} read${fresh ? ` (${fresh} new)` : ''}, ${stats.rules} left to the word rules, ${stats.waiting} waiting`
        + `${tiers.length ? ` · ${tiers.map(t => t.name).join(' → ')} · ${cache.calls}/${READER_DAILY_CAP} paid calls today` : ' · no reader tier here'}${summary.error ? ` · ${summary.error}` : ''}`);
    return summary;
}

/** `--reader-selftest`: one made-up alert through every configured tier, so a new key can be checked in one command. */
async function readerSelfTest() {
    const rink = { name: 'Example Arena', pads: 2, kinds: ['indoor'] };
    const a = { LocationID: 0, AssetName: 'Example Arena - Indoor Ice Rink', Type: 'Indoor Ice Rink', Status: 2, Reason: 'Maintenance/Repairs',
        Comments: 'Rink 2 is closed for board repairs and will reopen on Friday November 13, 2026. Rink 1 is open as usual.', PostedDate: '2026-11-10 09:00:00' };
    const tiers = readerTiers();
    if (!tiers.length) { console.log('🧠 no reader tier is configured (no key): the app\'s word rules read every alert'); return true; }
    let allOk = true;
    for (const t of tiers) {
        const t0 = Date.now();
        try {
            const { out, usage } = await t.call(readerUserMessage(a, rink));
            const v = verifyReading(a, rink, out, { by: t.by, trustDates: t.trustDates });
            const right = v.ok && v.read.skating === 'one_pad_off' && (!t.trustDates || v.read.ends === '2026-11-12');
            if (!right) allOk = false;
            console.log(`🧠 ${t.name.padEnd(10)} ${t.by.padEnd(40)} ${right ? 'OK  ' : 'WRONG'} ${Date.now() - t0} ms · ${usage.in ?? '?'} tokens in, ${usage.out ?? '?'} out`
                + (right ? '' : ` · ${v.ok ? JSON.stringify(v.read) : v.why}`));
        } catch (e) {
            allOk = false;
            console.log(`🧠 ${t.name.padEnd(10)} ${t.by.padEnd(40)} FAILED (${e.kind || 'error'}: ${readerScrub(e.message)})`);
        }
    }
    return allOk;
}

async function fetchAlerts(programs = null, rinks = null, external = null) {
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
    // Facility-wide notices from each rink location's own feed (deduped against the skate feed)
    if (programs && programs.length) {
        const locIds = programs.filter(p => !p.Source || p.Source === 'city').map(p => p['Location ID']).filter(x => x != null);
        try {
            const seen = new Set(all.map(a => `${a.LocationID}|${a.AssetID}|${a.PostedDate}`));
            (await fetchFacilityAlerts(locIds)).forEach(a => {
                const k = `${a.LocationID}|${a.AssetID}|${a.PostedDate}`;
                if (!seen.has(k)) { seen.add(k); all.push(a); }
            });
        } catch (e) { console.warn(`   ⚠️ facility feeds skipped: ${e.message}`); }
    }
    // Stable order → stable diffs
    all.sort((a, b) => (a.LocationID - b.LocationID) || String(a.AssetID).localeCompare(String(b.AssetID)));

    // What each alert means, read once by a model and verified against its own words (fail-soft)
    let reader = null;
    try { reader = await readAlerts(all, rinks); }
    catch (e) { console.warn(`   ⚠️ alert reader skipped: ${e.message} — the app's word rules decide`); }

    // v3.12: a board arena whose own site lists skating again, under a City notice from before it reopened
    const outlived = markSuperseded(all, reopenedNow(external));
    if (outlived) console.log(`   🏗️ ${outlived} City notice${outlived === 1 ? '' : 's'} outlived by the arena's own reopening (shown as a note)`);

    const alertsFile = path.join(OUTPUT_DIR, 'alerts.json');
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(alertsFile, 'utf8')); } catch {}

    const now = new Date().toISOString();
    const alertsChanged = !previous || JSON.stringify(previous.alerts) !== JSON.stringify(all);
    // the reader going down or coming back is worth a rewrite even when no alert moved
    const changed = alertsChanged || JSON.stringify(previous.reader || null) !== JSON.stringify(reader);
    // Heartbeat: even with no content change, refresh checkedAt every ~2h so
    // clients can tell "feed quiet" apart from "checker dead" and warn people
    // before they travel on stale data. ≤12 commits/day of overhead.
    const lastChecked = previous?.checkedAt || previous?.fetchedAt;
    const heartbeatDue = !lastChecked || (Date.now() - new Date(lastChecked).getTime()) > 2 * 3600 * 1000;

    if (changed || heartbeatDue) {
        fs.writeFileSync(alertsFile, JSON.stringify({
            fetchedAt: alertsChanged ? now : (previous?.fetchedAt || now),  // last CONTENT change
            checkedAt: now,                                                 // last successful check
            source: 'toronto.ca live parks data',
            ...(reader ? { reader } : {}),                                  // how the alerts were read (shown in the app's freshness menu)
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
function externalRecord(cfg, sourceKey, { activity, date, startTime, endTime, price, externalId, venue, ageMin, ageMax, registrationUrl, idKey }) {
    const v = venue || {};
    return {
        _id: `${sourceKey}-${externalId || idKey || `${date}-${startTime}`}`,
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
        .replace(/<!--[\s\S]*?-->/g, ' ')          // v3.12: a commented-out line is not on the page (Harbourfront keeps old status lines in comments)
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

        const rule = { weekday, start, end, text: segment.slice(0, 240) };
        // "Starts October 2nd, 2026" → nothing before that date
        const st = segment.match(/\b(?:starts|starting|begins|beginning|resumes?)\s+(?:on\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/i);
        if (st) {
            const y = st[3] ? parseInt(st[3], 10) : new Date().getFullYear();
            rule.from = `${y}-${String(MONTHS[st[1].toLowerCase()]).padStart(2, '0')}-${String(parseInt(st[2], 10)).padStart(2, '0')}`;
        }
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
const SCHEDULE_PROMPT = (text) => `Extract the public skating schedule from this arena webpage text. Reply with JSON: {"rules":[{"weekday":"Monday".."Sunday","start":"HH:MM","end":"HH:MM"(24h),"from":"YYYY-MM-DD"(optional, only if that line is limited to a date range),"to":"YYYY-MM-DD"(optional),"label":"the exact line of the page this rule comes from, copied word for word"}]}. Times like "12 – 1 pm" are 12:00-13:00. If a line says a special range like "Saturdays June 27 to July 18 2026 from 12noon to 2pm", include from/to. Only sessions that are actually listed; never invent any.\n\nPAGE TEXT:\n${text.slice(0, 4000)}`;
const SCHEDULE_SCHEMA = {
    type: 'object',
    properties: { rules: { type: 'array', items: { type: 'object', properties: {
        weekday: { type: 'string', enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] },
        start: { type: 'string' }, end: { type: 'string' },
        from: { type: ['string', 'null'] }, to: { type: ['string', 'null'] },
        label: { type: 'string' }
    }, required: ['weekday', 'start', 'end', 'label'] } } },
    required: ['rules']
};

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
function rulesFromModelText(textOut, label, pageText) {
    const raw = String(textOut || '').replace(/^```json\s*|```$/g, '').trim();
    let rules;
    try { const obj = JSON.parse(raw); rules = Array.isArray(obj) ? obj : obj && obj.rules; }
    catch { const m = raw.match(/\[[\s\S]*\]/); rules = m ? JSON.parse(m[0]) : null; }
    if (!Array.isArray(rules)) return null;
    // A rule the model cannot back with a line of the page is a guess: dropped.
    const corpus = pageText ? normQuote(pageText) : null;
    const ok = rules
        .filter(r => WEEKDAYS.includes(r.weekday) && /^\d{2}:\d{2}$/.test(r.start || '') && /^\d{2}:\d{2}$/.test(r.end || '')
            && (!corpus || (r.label && corpus.includes(normQuote(r.label)))))
        .map(r => ({ weekday: r.weekday, start: r.start, end: r.end, ...(r.from ? { from: r.from } : {}), ...(r.to ? { to: r.to } : {}), text: r.label || '' }));
    console.log(`   🤖 ${label} parsed ${ok.length} schedule rules${rules.length !== ok.length ? ` (${rules.length - ok.length} rejected: no verbatim line of the page)` : ''}`);
    return ok.length ? ok : null;
}

async function llmParseSchedule(text) {
    const ollama = (process.env.OLLAMA_URL || '').replace(/\/+$/, '');
    if (ollama) {
        try {
            const model = process.env.OLLAMA_MODEL || 'llama3.1';
            const res = await postText(`${ollama}/api/chat`, JSON.stringify({
                model, stream: false, think: false, format: SCHEDULE_SCHEMA,   // think:false: a reasoning model otherwise thinks for minutes
                options: { temperature: 0, num_ctx: 8192 },
                messages: [{ role: 'user', content: SCHEDULE_PROMPT(text) }]
            }), {}, 120000);
            const parsed = JSON.parse(res);
            const out = parsed.message?.content ?? parsed.response ?? '';
            const rules = rulesFromModelText(out, `Ollama (${model})`, text);
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
        return rulesFromModelText(parsed.content?.[0]?.text || '', 'Claude', text);
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
    let text = stripHtml(contentMatch ? contentMatch[1] : html);
    // One page, several programs (Leaside: adults-only, family skate, ticket ice):
    // each source reads only its own section of the text.
    if (cfg.section) {
        const a = text.search(cfg.section.from);
        if (a >= 0) {
            const rest = text.slice(a);
            const b = cfg.section.to ? rest.slice(1).search(cfg.section.to) : -1;
            text = b >= 0 ? rest.slice(0, b + 1) : rest;
        }
    }
    console.log(`   📄 ${sourceKey} page text: "${text.slice(0, 160)}…"`);

    // The deterministic parser first; the local model only reads pages the
    // regex cannot, and every model rule must quote a line of the page.
    let rules = process.env.SCHEDULE_PREFER_LLM ? [] : parseScheduleText(text);   // SCHEDULE_PREFER_LLM=1: exercise the model path
    if (!rules.length) rules = (await llmParseSchedule(text)) || parseScheduleText(text);
    // One page, several programs on the same lines (Leaside lists adults-only
    // and all-ages skates under one heading): keep the lines this source owns.
    if (cfg.only) rules = rules.filter(r => cfg.only.test(r.text || ''));
    if (cfg.skip) rules = rules.filter(r => !cfg.skip.test(r.text || ''));
    if (!rules.length) { const e = new Error('no schedule rules parsed from page'); e.code = 'EMPTY'; throw e; }
    console.log(`   📋 rules: ${rules.map(r => `${r.weekday} ${r.start}-${r.end}${r.from || r.to ? ` (${r.from ? `from ${r.from}` : ''}${r.to ? ` to ${r.to}` : ''})` : ''}`).join(', ')}`);

    const today = torontoDateStr();
    const records = [];
    for (let i = 0; i < cfg.daysAhead; i++) {
        const date = addDays(today, i);
        const weekday = weekdayOf(date);
        // season window ("October 1 – April 30"): month-day bounds that wrap the new year
        if (cfg.season) {
            const md = date.slice(5);
            const inSeason = cfg.season.from <= cfg.season.to ? (md >= cfg.season.from && md <= cfg.season.to) : (md >= cfg.season.from || md <= cfg.season.to);
            if (!inSeason) continue;
        }
        rules.forEach(r => {
            if (r.weekday !== weekday) return;
            if (r.from && date < r.from) return;
            if (r.to && date > r.to) return;
            records.push(externalRecord(cfg, sourceKey, {
                activity: cfg.activity, date, startTime: r.start, endTime: r.end, ageMin: cfg.ageMin, ageMax: cfg.ageMax, price: cfg.price
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
    const rules = cfg.layout === 'weekday-lines' ? parseWeekdayLinesText(text, cfg) : cfg.layout === 'day-grid' ? parseDayGridText(text, cfg) : parseWeekdayGridText(text, cfg);
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

/* ================= Per-session .ics files (home server only) =================
 * iOS refuses data: URLs, so "Add to calendar" on Apple devices opens a real
 * https .ics instead. When ICS_DIR is set (dell-nix skate-data runner), the
 * full run writes one file per session for the next 45 days, named by the
 * app's favourites id (a mirror of Favorites.getId in chat-v2.js: FNV-1a +
 * murmur finalizer, first 16 hex chars). Stale files are pruned by the runner. */
function favouriteId(p) {
    const str = `${p.Activity || ''}|${p.LocationName || ''}|${p['Start Date'] || ''}|${p['Start Time'] || ''}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { hash ^= str.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
    let out = '';
    for (let round = 0; round < 4; round++) {
        hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
        hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
        hash ^= hash >>> 16;
        out += (hash >>> 0).toString(16).padStart(8, '0');
    }
    return out.slice(0, 16);
}
// Wall-clock times with a VTIMEZONE: Calendar apps then show 11:30 AM EDT, not
// a "(GMT)" conversion. Only DTSTAMP is UTC.
const ICS_VTIMEZONE = [
    'BEGIN:VTIMEZONE', 'TZID:America/Toronto',
    'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'END:DAYLIGHT',
    'END:VTIMEZONE'
];
const icsLocal = (dateKey, hhmm) => `${dateKey.replace(/-/g, '')}T${String(hhmm || '00:00').replace(':', '').padStart(4, '0')}00`;
const icsStamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const icsEsc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function writeIcsFiles(programs, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const today = torontoDateStr(), until = addDays(today, 45);
    const site = 'https://sunmoonron.github.io/skate/';
    let n = 0;
    programs.forEach(p => {
        const date = p['Start Date'] || '';
        if (date < today || date > until || !p['Start Time']) return;
        const startT = p['Start Time'], endT = p['End Time'] || '';
        const endDate = endT && endT <= startT ? addDays(date, 1) : date;   // crosses midnight
        const id = favouriteId(p);
        const city = (p.Source && p.Source !== 'city' && p.District) ? p.District : 'Toronto';
        const addr = [p.Address, p.PostalCode].filter(Boolean).join(', ');
        const min = parseInt(p['Age Min'], 10), max = parseInt(p['Age Max'], 10);
        const ages = Number.isFinite(min) && min > 0 && Number.isFinite(max) ? `Ages ${min}–${max}` : Number.isFinite(min) && min > 0 ? `${min >= 18 ? 'Adults' : 'Ages'} ${min}+` : Number.isFinite(max) ? `Up to ${max}` : 'All ages';
        const official = (!p.Source || p.Source === 'city') && p['Location ID'] != null
            ? `https://www.toronto.ca/explore-enjoy/parks-recreation/places-spaces/parks-and-recreation-facilities/location/?id=${p['Location ID']}`
            : (/^https?:\/\//.test(p.InfoUrl || '') ? p.InfoUrl : '');
        const details = [
            `${p.Activity} · ${ages}`,
            addr ? `${p.LocationName}, ${addr}` : p.LocationName,
            p.Paid ? `Paid session${p.Price != null ? `, $${Number(p.Price).toFixed(2).replace(/\.00$/, '')}` : ''}${p.RegistrationUrl ? ` · ${p.RegistrationUrl === p.InfoUrl ? 'Details' : 'Register'}: ${p.RegistrationUrl}` : ''}` : (p.PriceNote || 'Free drop-in'),
            p.Unverified ? 'Unverified schedule (read from the venue site). Confirm with the venue.' : '',
            official ? `Verify: ${official}` : '',
            `Toronto Skating: ${site}#p=${id}`
        ].filter(Boolean).join('\n');
        const ics = [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Toronto Skating//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
            ...ICS_VTIMEZONE,
            'BEGIN:VEVENT',
            `UID:${id}@toronto-skating`,
            `DTSTAMP:${icsStamp(Date.now())}`,
            `DTSTART;TZID=America/Toronto:${icsLocal(date, startT)}`,
            `DTEND;TZID=America/Toronto:${endT ? icsLocal(endDate, endT) : icsLocal(date, startT)}`,
            `SUMMARY:${icsEsc(`${p.Activity} at ${p.LocationName}`)}`,
            `LOCATION:${icsEsc(`${p.LocationName}${addr ? ', ' + addr : ''}, ${city}, ON`)}`,
            `DESCRIPTION:${icsEsc(details)}`,
            `URL:${site}#p=${id}`,
            'END:VEVENT', 'END:VCALENDAR'
        ].join('\r\n');
        fs.writeFileSync(path.join(dir, `${id}.ics`), ics);
        n++;
    });
    console.log(`   📆 ${n} .ics files in ${dir}`);
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
/* ================= PickupHub (Leaside Gardens' ticket ice + adult shinny) =================
 *
 * pickuphub.net is a Laravel/Inertia app: a provider page embeds its data
 * as JSON in <script data-page="app" type="application/json">, eight games
 * per cursor page, each with exact start/end, pad, price before tax,
 * capacity, registered count and the moment registration unlocks. The site
 * sends no CORS headers, so the browser cannot read it: the pipeline does,
 * and the light pass (every 10 min on the home server) re-reads the counts
 * into live-spots.json, which the app's SkateLive merges like DaySmart's
 * live feed.
 */
const LIVE_SPOTS_FILE = 'live-spots.json';
const LIVE_SPOTS = {};   // ExternalId → { open, capacity, status, opensAt, at }, filled by every pickuphub read this run
const HST = 1.13;
const PICKUPHUB_UA = { 'User-Agent': 'Mozilla/5.0 (compatible; toronto-skating-site-data-fetcher)' };

function inertiaProps(html) {
    const m = html.match(/<script[^>]*data-page="app"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) throw new Error('no Inertia page data on the page');
    return JSON.parse(m[1]).props || {};
}

/** Wall-clock date + HH:MM of an ISO stamp that already carries the venue's offset ("2026-10-08T11:15:00-04:00"). */
function localParts(iso) {
    const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return m ? { date: m[1], time: m[2] } : null;
}

function noteLiveSpots(game) {
    const cap = game.capacity || {};
    const max = typeof cap.max_players === 'number' ? cap.max_players : null;
    const n = typeof cap.players_count === 'number' ? cap.players_count : null;
    LIVE_SPOTS[String(game.id)] = {
        open: (max != null && n != null) ? Math.max(0, max - n) : null,
        capacity: max,
        status: game.is_locked ? 'upcoming' : (cap.is_full || cap.players_full ? 'full' : 'open'),
        ...(game.is_locked && game.unlock_at ? { opensAt: game.unlock_at } : {}),
        endsAt: game.end_at || null,
        at: new Date().toISOString()
    };
}

/** The provider's upcoming games, cursor page by cursor page, until the horizon. */
async function pickupHubGames(cfg, { maxPages = 10, horizonDays = cfg.daysAhead || 35 } = {}) {
    const games = [];
    const last = addDays(torontoDateStr(), horizonDays);
    let url = `https://pickuphub.net/${cfg.slug}`;
    for (let i = 0; url && i < maxPages; i++) {
        const page = inertiaProps(await httpGetText(url, PICKUPHUB_UA)).games || {};
        const data = page.data || [];
        games.push(...data);
        const tail = data.length ? localParts(data[data.length - 1].start_at) : null;
        if (!data.length || (tail && tail.date > last)) break;
        url = page.links && page.links.next;
    }
    return games;
}

async function fetchPickupHub(sourceKey, cfg) {
    const games = await pickupHubGames(cfg);
    const today = torontoDateStr(), last = addDays(today, cfg.daysAhead || 35);
    const records = [];
    games.forEach(g => {
        const s = localParts(g.start_at), e = localParts(g.end_at);
        if (!s || !e || s.date < today || s.date > last) return;
        const label = cfg.activities[(g.sport && g.sport.slug) || ''];
        if (!label) return;                                   // a sport the app does not list
        noteLiveSpots(g);
        const padName = (g.location && g.location.name) || '';
        const pad = (padName.match(/^(?:Rink|Pad)\s+\w+/i) || [padName])[0];
        const age = (g.age_label || '').match(/(\d+)\s*\+/);
        const cost = (g.pricing && typeof g.pricing.player_cost === 'number') ? Math.round(g.pricing.player_cost * HST * 100) / 100 : undefined;
        records.push(externalRecord(cfg, sourceKey, {
            activity: pad ? `${label} · ${pad}` : label,
            date: s.date, startTime: s.time, endTime: e.time,
            price: cost, externalId: g.id, registrationUrl: g.url,
            ageMin: age ? parseInt(age[1], 10) : cfg.ageMin
        }));
    });
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions from ${games.length} listed games`);
    return records;
}

/**
 * live-spots.json: the counts noted this run merged over the previous file
 * (the light pass only re-reads the next two weeks; a full run's later
 * entries stay until their session ends). Nothing fetched → file untouched.
 */
function writeLiveSpots() {
    const ids = Object.keys(LIVE_SPOTS);
    if (!ids.length) { console.log(`   · ${LIVE_SPOTS_FILE}: no counts read this run, keeping the previous file`); return; }
    const file = path.join(OUTPUT_DIR, LIVE_SPOTS_FILE);
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')).byId || {}; } catch {}
    const now = Date.now();
    const byId = {};
    Object.entries({ ...prev, ...LIVE_SPOTS }).forEach(([id, v]) => {
        const ended = v.endsAt ? new Date(v.endsAt).getTime() < now : (now - new Date(v.at || 0).getTime()) > 2 * 86400000;
        if (!ended) byId[id] = v;
    });
    fs.writeFileSync(file, JSON.stringify({ checkedAt: new Date().toISOString(), byId }));
    console.log(`   ✅ ${LIVE_SPOTS_FILE}: ${ids.length} sessions re-read, ${Object.keys(byId).length} on file`);
}

/** Light pass: re-read the next two weeks of counts (two or three small pages per venue). */
async function refreshLiveSpots() {
    for (const [key, cfg] of Object.entries(EXTERNAL_SOURCES)) {
        if (cfg.kind !== 'pickuphub') continue;
        try {
            const games = await pickupHubGames(cfg, { maxPages: 3, horizonDays: 14 });
            games.forEach(g => { if (cfg.activities[(g.sport && g.sport.slug) || '']) noteLiveSpots(g); });
            console.log(`   🎟️  ${key}: ${games.length} games re-read for live counts`);
        } catch (e) {
            console.warn(`   ⚠️ ${key} live counts: ${(e && (e.message || e.code)) || String(e)}`);
            if (e && !e.message && e.stack) console.warn(`      ${e.stack.split('\n').slice(0, 2).join(' | ')}`);
        }
    }
    writeLiveSpots();
}

const FETCHERS = { daysmart: fetchDaySmart, perfectmind: fetchPerfectMind, activenet: fetchActiveNet, scrape: fetchScraped, pdf: fetchPdfSchedule, intelligenz: fetchIntelligenz, 'html-grid': fetchHtmlGrid, pickuphub: fetchPickupHub,
    venue: fetchVenue, watch: fetchWatch, manual: fetchManual, 'calendar-image': fetchCalendarImage, aurora: fetchAurora, whitby: fetchTablePage, uoft: fetchTablePage };

/* ================= Seasons, venue pages and source states (v3.12) =================
 *
 * A source used to be either "ok" or "failed", and a rink that only exists in
 * winter failed all summer. Each source now ends a run in one of these states,
 * written to meta.json for the app's status page:
 *   ok       read, sessions listed
 *   pending  read; the venue is not open yet (or has not posted the season)
 *   closed   read; the venue's own page says closed for the season
 *   none     read; the venue's own page says it offers no public skating
 *   changed  read; a page that is only watched no longer says what it did
 *   dormant  out of season: the page is not fetched at all
 *   failed   could not be read or understood; recent sessions are kept
 */

/** 'MM-DD' inside [from, to], bounds that may wrap the new year. */
function mdInRange(md, from, to) { return from <= to ? (md >= from && md <= to) : (md >= from || md <= to); }

/**
 * Where a day falls against a source's season ({ from: 'MM-DD', to: 'MM-DD', lead: days }):
 *   null                             year-round source
 *   { phase: 'in' }                  inside the season
 *   { phase: 'lead', opens }         in the lead-in before it (venues post early, so the page is read)
 *   { phase: 'out', opens, resumes } out of season; `resumes` is the day reading starts again
 */
function seasonPhase(cfg, today) {
    const s = cfg && cfg.season;
    if (!s) return null;
    if (mdInRange(today.slice(5), s.from, s.to)) return { phase: 'in' };
    const y = +today.slice(0, 4);
    let opens = `${y}-${s.from}`;
    if (opens < today) opens = `${y + 1}-${s.from}`;
    const resumes = addDays(opens, -(s.lead ?? 30));
    return today >= resumes ? { phase: 'lead', opens } : { phase: 'out', opens, resumes };
}

const isYmdStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isHmStr = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** The sentence of `text` that starts at position `at` (to its full stop), at most `max` characters. */
function sentenceFrom(text, at, max = 160) {
    let b = at;
    while (b < text.length && !/[.!?]/.test(text[b]) && b - at < max) b++;
    return text.slice(at, Math.min(text.length, b + 1)).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A row of a multi-rink page: is that rink open? The reader says so (`open`); its status text is the fallback. */
const rowIsOpen = (v) => (v && typeof v.open === 'boolean' ? v.open : /^open\b/i.test(String((v && v.status) || '').trim()));
/** A multi-venue page (Brampton's table): the configured rink a row of the page is about. */
function venueFor(cfg, sourceKey, rowName) {
    const v = (cfg.venueList || []).find(x => x.match.test(rowName || ''));
    return v ? { name: v.name, address: v.address, district: cfg.defaultDistrict || '', postalCode: v.postalCode || '', lat: v.lat, lng: v.lng, extKey: venueKey(sourceKey, v.name) } : null;
}

/**
 * Reading (from skate-venues.js) → program records, for one source. Pure, so the
 * tests can run it. A session with a bad date or time, a duplicate, or (on a
 * multi-venue page) a rink the config does not know is dropped; unknown rinks
 * are returned by name so the run can say so.
 */
function venueRecords(sourceKey, cfg, sessions) {
    const records = [], unknown = new Set(), seen = new Set();
    (sessions || []).forEach(s => {
        if (!s || !isYmdStr(s.date) || !isHmStr(s.start) || !isHmStr(s.end) || s.end <= s.start) return;
        let venue = null;
        if (cfg.venueList) {
            venue = venueFor(cfg, sourceKey, s.venue);
            if (!venue) { unknown.add(String(s.venue || '?')); return; }
        }
        const activity = String(s.activity || cfg.activity || 'Public Skating');
        const k = `${venue ? venue.name : ''}|${s.date}|${s.start}|${s.end}|${activity}`;
        if (seen.has(k)) return;
        seen.add(k);
        // ages a page writes into the program's name ("Shinny Drop-In – Ages 18+", "… Ages 17 and Under")
        const plus = /\bages?\s+(\d{1,2})\s*\+/i.exec(activity), under = /\bages?\s+(\d{1,2})\s+and\s+under\b/i.exec(activity);
        const rec = externalRecord(cfg, sourceKey, {
            activity, date: s.date, startTime: s.start, endTime: s.end, venue, idKey: slugOf(k),
            ageMin: s.ageMin ?? (plus ? Number(plus[1]) : cfg.ageMin), ageMax: s.ageMax ?? (under ? Number(under[1]) : cfg.ageMax), price: cfg.price
        });
        if (s.note) rec.PriceNote = [String(s.note).replace(/[.\s]+$/, ''), rec.PriceNote].filter(Boolean).join('. ');
        records.push(rec);
    });
    records.sort((a, b) => (a['Start Date'] + a['Start Time']).localeCompare(b['Start Date'] + b['Start Time']) || a.LocationName.localeCompare(b.LocationName));
    return { records, unknown: [...unknown] };
}

/**
 * A reader takes apart a page from someone else's server with regular expressions.
 * It runs on a worker thread with a time limit: a page that makes a pattern crawl
 * (by accident or on purpose), or a plain bug, then costs one source one run
 * instead of hanging the whole refresh. The largest of these pages is about 200 KB;
 * anything over 2 MB is not read at all.
 */
const READER_LIMIT_MS = 15000;
const READER_MAX_CHARS = 2 * 1024 * 1024;
function runReader(name, body, ctx, { ms = READER_LIMIT_MS, modulePath = path.join(__dirname, 'skate-venues.js') } = {}) {
    return new Promise((resolve, reject) => {
        if (typeof body !== 'string' || body.length > READER_MAX_CHARS) return reject(new Error(`page too large to read (${typeof body === 'string' ? body.length : typeof body})`));
        const { Worker } = require('worker_threads');
        const worker = new Worker(
            `const { parentPort, workerData } = require('worker_threads');
             const read = require(workerData.modulePath).READERS[workerData.name];
             parentPort.postMessage(read ? { ok: true, reading: read(workerData.body, workerData.ctx) } : { ok: false, error: "no reader '" + workerData.name + "' in skate-venues.js" });`,
            { eval: true, workerData: { modulePath, name, body, ctx } });
        let done = false;
        const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); worker.terminate(); fn(value); };
        const timer = setTimeout(() => finish(reject, Object.assign(new Error(`the page reader '${name}' ran past ${ms / 1000} s and was stopped`), { code: 'SLOW' })), ms);
        worker.once('message', (m) => (m && m.ok ? finish(resolve, m.reading) : finish(reject, new Error((m && m.error) || 'the page reader sent nothing back'))));
        worker.once('error', (e) => finish(reject, e));
        worker.once('exit', (code) => finish(reject, new Error(`the page reader '${name}' stopped early (exit ${code})`)));
    });
}

/** kind 'venue': fetch the page(s); a pure reader in skate-venues.js says what they mean. (`get` and `reader` are swapped out by the tests.) */
async function fetchVenue(sourceKey, cfg, { get = httpGetText, reader = runReader, today = torontoDateStr() } = {}) {
    const ctx = { today, daysAhead: cfg.daysAhead || 14 };
    // One more try after a pause when a page does not arrive or does not read: these sites now and
    // then answer one request with an error page (seen on 2026-11-21: one bad answer in five from
    // one of them, fine a second later). A page that has really changed fails both times.
    const once = async (name, url) => {
        const reading = await reader(name, await get(url), ctx);
        if (!reading || reading.state === 'unknown') {
            const e = new Error(`page not understood: ${(reading && reading.note) || 'no reading'}`);
            e.code = 'LAYOUT';
            throw e;
        }
        return reading;
    };
    const read = async (name, url) => {
        try { return await once(name, url); }
        catch (e) {
            if (e && e.code === 'SLOW') throw e;                      // a reader that ran out of time is not asked twice
            console.warn(`   ↻ ${sourceKey}: ${e.message}; trying once more`);
            await sleep(cfg.retryMs ?? 3000);
            return once(name, url);
        }
    };
    const main = await read(cfg.reader, cfg.url);
    const sessions = [...(main.sessions || [])];
    const notes = [];
    // One rink of a multi-rink page can keep its timetable on a page of its own (Gore Meadows):
    // read it only while the main table says that rink is open.
    for (const extra of cfg.also || []) {
        const row = (main.venues || []).find(v => { const c = venueFor(cfg, sourceKey, v.name); return c && c.name === extra.venue; });
        if (row && !rowIsOpen(row)) continue;
        try {
            const r = await read(extra.reader, extra.url);
            (r.sessions || []).forEach(s => sessions.push({ ...s, venue: s.venue || extra.venue }));
            if (r.state !== 'open' && r.note) notes.push(`${extra.venue}: ${r.note}`);
        } catch (e) {
            console.warn(`   ⚠️ ${sourceKey}: ${extra.venue} timetable skipped (${e.message})`);
            notes.push(`${extra.venue}: its timetable page could not be read this time.`);
        }
    }
    const { records, unknown } = venueRecords(sourceKey, cfg, sessions);
    if (unknown.length) {
        console.warn(`   ⚠️ ${sourceKey}: rink(s) on the page the app does not know yet: ${unknown.join(', ')}`);
        notes.push(`New on its page, not in the app yet: ${unknown.join(', ')}.`);
    }
    const venues = (main.venues || []).map(v => { const c = venueFor(cfg, sourceKey, v.name); return c ? { key: c.extKey, name: c.name, open: rowIsOpen(v), status: String(v.status || '').slice(0, 60), reason: String(v.reason || '').slice(0, 80) } : null; }).filter(Boolean);
    console.log(`   ✅ ${sourceKey}: ${main.state}, ${records.length} sessions${main.quote ? ` · page says: "${main.quote}"` : ''}`);
    return {
        records,
        state: main.state === 'open' ? 'ok' : main.state,          // 'pending' | 'closed' pass through
        note: [main.note, ...notes].filter(Boolean).join(' ').slice(0, 300),
        quote: main.quote ? String(main.quote).slice(0, 160) : '',
        season: main.season || null,
        venues
    };
}

/** kind 'watch': a place with no public skating. Re-read the sentence that says so. */
async function fetchWatch(sourceKey, cfg) {
    const text = stripHtml(await httpGetText(cfg.url));
    const m = cfg.says.exec(text);
    if (!m) {
        console.warn(`   ⚠️ ${sourceKey}: the sentence this page is watched for is gone`);
        return { records: [], state: 'changed', note: 'Its page no longer says what it did when it was last looked at. It needs a look.' };
    }
    const quote = sentenceFrom(text, m.index);
    console.log(`   ✅ ${sourceKey}: still says "${quote}"`);
    return { records: [], state: 'none', quote };
}

/** Hand-entered hours (`rules`, `dates`, `closedOn`) → dated sessions for [today, today + daysAhead]. Pure. */
function manualRecords(sourceKey, cfg, today) {
    const records = [];
    for (let i = 0; i <= (cfg.daysAhead || 14); i++) {
        const date = addDays(today, i), wd = weekdayOf(date);
        if (date < cfg.dates.from || date > cfg.dates.to || (cfg.closedOn || []).includes(date)) continue;
        cfg.rules.forEach(r => {
            if (date < r.from || date > r.to || !r.days.includes(wd)) return;
            records.push(externalRecord(cfg, sourceKey, { activity: cfg.activity, date, startTime: r.start, endTime: r.end, ageMin: cfg.ageMin, ageMax: cfg.ageMax, price: cfg.price }));
        });
    }
    return records;
}

/**
 * kind 'manual': hours entered by hand because the venue's site does not allow
 * automated reading of them. The public page is still fetched (`watch`): if it is
 * gone or about something else, nothing is listed and the status page says why.
 */
async function fetchManual(sourceKey, cfg, { get = httpGetText, today = torontoDateStr() } = {}) {
    let edited = null, republished = null, pageEdit = '';
    if (cfg.watch) {
        const html = await get(cfg.watch.url);
        if (!cfg.watch.says.test(html)) {
            console.warn(`   ⚠️ ${sourceKey}: its page changed since the hours were entered by hand`);
            return { records: [], state: 'changed', manual: cfg.enteredOn, season: cfg.dates, note: 'Its page changed since the hours were entered by hand. Nothing is listed until they are checked again.' };
        }
        if (cfg.watch.sitemap) {
            // The hours cannot be read, but the site's own page list says when the page was last edited.
            // A failure here is not a failure of the source: the page itself was just read.
            try {
                const entry = sitemapLastmod(await get(cfg.watch.sitemap), cfg.watch.url);
                const seen = Date.parse(cfg.watch.seen);
                if (!entry || entry.at == null) console.warn(`   ⚠️ ${sourceKey}: its page is not in the site's page list (or has no edit time there), so an edit cannot be noticed`);
                else pageEdit = new Date(entry.at).toISOString().replace('.000Z', 'Z');
                if (pageEdit && entry.at > seen) {
                    const stamp = pageEdit;
                    const day = torontoDateStr(new Date(entry.at));
                    // the same moment on many pages is the whole site being republished, not this page being edited
                    if (entry.shared >= SITEMAP_BULK) { republished = day; console.log(`   · ${sourceKey}: the whole site was republished ${stamp} (${entry.shared} other pages carry that time)`); }
                    else { edited = day; console.warn(`   ⚠️ ${sourceKey}: its page was edited ${stamp}, after the hours were entered (the edit seen then: ${cfg.watch.seen})`); }
                }
            } catch (e) {
                console.warn(`   ⚠️ ${sourceKey}: the site's page list could not be read (${errorText(e)}), so an edit cannot be noticed this run`);
            }
        }
    }
    const flags = edited ? { edited } : {};
    // The hours on file are for a winter that is over, and the next one is near or here.
    if (today > cfg.dates.to && winterOf(today) !== winterOf(cfg.dates.to)) {
        console.log(`   ⏳ ${sourceKey}: the hours on file are last winter's; this winter's have not been entered`);
        return { records: [], state: 'pending', note: 'This winter\'s hours have not been entered yet. They are typed in by hand once its site posts them.', ...flags };
    }
    const records = manualRecords(sourceKey, cfg, today);
    const state = today > cfg.dates.to ? 'closed' : today < cfg.dates.from ? 'pending' : 'ok';
    console.log(`   ✅ ${sourceKey}: ${state}, ${records.length} sessions from hours entered by hand on ${cfg.enteredOn}${pageEdit ? ` · its page was last edited ${pageEdit}` : ''}`);
    const note = republished ? `Its whole site was republished on ${monthDay(republished)}, after these hours were entered.` : '';
    return { records, state, manual: cfg.enteredOn, season: cfg.dates, ...flags, ...(note ? { note } : {}) };
}
const SITEMAP_BULK = 4;      // this many other pages with the same edit time: a republish of the site, not an edit of the page
const monthDay = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/**
 * A sitemap → { at, shared } for the page `loc`: when it was last modified (ms), and how many
 * other pages carry that same moment, give or take two seconds. null when the page is not
 * listed; `at` null when it is listed without a time. Plain scanning, no backtracking. Pure.
 */
function sitemapLastmod(xml, loc) {
    const src = String(xml || '');
    if (src.length > 3000000) return null;
    const norm = (u) => String(u).replace(/&amp;/g, '&').replace(/\/+$/, '').toLowerCase();
    const want = norm(loc);
    const others = [];
    let found = false, mine = null, i = 0;
    for (;;) {
        const a = src.indexOf('<url>', i);
        if (a < 0) break;
        const b = src.indexOf('</url>', a);
        if (b < 0) break;
        const block = src.slice(a + 5, b);
        i = b + 6;
        const l = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(block), d = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i.exec(block);
        if (!l) continue;
        const t = d ? Date.parse(d[1]) : NaN;
        if (norm(l[1]) === want) { found = true; mine = Number.isFinite(t) ? t : null; }
        else if (Number.isFinite(t)) others.push(t);
    }
    if (!found) return null;
    return { at: mine, shared: mine == null ? 0 : others.filter(t => Math.abs(t - mine) <= 2000).length };
}

/* ================= Monthly calendar pictures (v3.12.3) =================
 *
 * Some arenas post their drop-in month only as a picture (Ford Performance Centre: a PNG
 * at the top of its drop-in page). The page is read for pictures whose file name says a
 * month, a calendar or a schedule; each new picture (by its bytes) is read once by the
 * alert reader's model, and the reading is kept in calendar-readings.json, so a picture
 * costs one call however many runs see it. A reading is believed only if every event
 * sits in the weekday column the picture shows it in: a misread month or a shifted row
 * breaks that for nearly every date, and the picture is then left unread rather than
 * half believed. Without a key (GitHub's runners) only pictures already read are used.
 */
const CAL_READINGS_FILE = 'calendar-readings.json';
const CAL_READ_LIMIT = 2;                          // new pictures read per run, at most
const CAL_IMG_MAX = 8 * 1024 * 1024;
const CAL_RETRY_MS = 24 * 3600000;                 // a picture that could not be believed is tried again after a day
const CAL_KEEP_MS = 150 * 86400000;                // readings of pictures not seen for this long are dropped
const CAL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const CAL_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CAL_NAME_RE = /(?:^|[^a-z])(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:[^a-z]|$)|calendar|schedule/i;
const CAL_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['heading', 'month', 'year', 'events', 'notes'],
    properties: {
        heading: { type: 'string' },
        month: { type: 'integer' },
        year: { type: 'integer' },
        events: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false,
                required: ['day', 'weekday', 'title', 'start', 'end'],
                properties: {
                    day: { type: 'integer' },
                    weekday: { type: 'string', enum: CAL_WEEKDAYS },
                    title: { type: 'string' },
                    start: { type: 'string' },
                    end: { type: 'string' }
                }
            }
        },
        notes: { type: 'array', items: { type: 'string' } }
    }
};
const CAL_SYSTEM = `You read a picture of an arena's monthly calendar and report only what is printed on it.
heading: the calendar's title exactly as printed (for example "November 2026").
month (1 to 12) and year: the month the calendar is for.
events: every event printed inside a day cell of that month. Skip the greyed-out days that belong to the month before or after. For each event: day is the number of the cell it is in; weekday is the column heading above that cell; title is the event's name as printed, its lines joined with spaces; start and end are its times in 24-hour HH:MM (5:15pm is 17:15). A cell with two events gives two entries. Leave out an event whose time you cannot read.
notes: other printed lines that apply to the events (fees, helmet rules), as printed.`;

/** A page → the calendar pictures it links or shows (full size before resized copies), at most four. Pure. */
function calendarPictures(html, base) {
    const src = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
    if (src.length > 3000000) return [];
    const found = [];
    const add = (raw) => {
        try {
            const u = new URL(raw.replace(/&amp;/g, '&'), base);
            const name = decodeURIComponent(u.pathname.split('/').pop() || '');
            if (!/^https?:$/.test(u.protocol) || !/\.(png|jpe?g|webp|gif)$/i.test(name) || !CAL_NAME_RE.test(name.replace(/\.\w+$/, ''))) return;
            if (!found.includes(u.href)) found.push(u.href);
        } catch { /* not a URL */ }
    };
    for (const m of src.matchAll(/<a\b[^>]*?\bhref="([^"]{1,600})"/gi)) add(m[1]);
    for (const m of src.matchAll(/<img\b[^>]*?\bsrc="([^"]{1,600})"/gi)) add(m[1]);
    // "November-1-1024x791.png" is a smaller copy of "November-1.png": read the full one only
    const full = (u) => u.replace(/-\d{2,4}x\d{2,4}(\.\w+)$/, '$1');
    return found.filter(u => full(u) === u || !found.includes(full(u))).slice(0, 4);
}

/**
 * What the model said a picture shows → { ok: true, month, year, events: [{ date, title, start, end }], notes }
 * or { ok: false, why }. Every event must sit on its weekday, or none is believed. Pure.
 */
function checkCalendarReading(r) {
    if (!r || typeof r !== 'object') return { ok: false, why: 'no reading' };
    const { month, year } = r;
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2025 || year > 2100) return { ok: false, why: 'it gave no month and year' };
    const head = String(r.heading || '').toLowerCase();
    const M = (m) => m.replace(/^./, c => c.toUpperCase());
    const named = CAL_MONTHS.filter(m => new RegExp(`\\b${m.slice(0, 3)}`).test(head));
    if (named.length && !named.includes(CAL_MONTHS[month - 1])) return { ok: false, why: `the heading says ${M(named[0])}, not ${M(CAL_MONTHS[month - 1])}` };
    const years = head.match(/\b20\d\d\b/g) || [];
    if (years.length && !years.includes(String(year))) return { ok: false, why: `the heading says ${years[0]}, not ${year}` };
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const time = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
    const events = [];
    for (const e of Array.isArray(r.events) ? r.events.slice(0, 200) : []) {
        if (!e || !Number.isInteger(e.day) || e.day < 1 || e.day > last) return { ok: false, why: `day ${e && e.day} is not in ${M(CAL_MONTHS[month - 1])}` };
        const wd = CAL_WEEKDAYS[new Date(Date.UTC(year, month - 1, e.day)).getUTCDay()];
        if (e.weekday !== wd) return { ok: false, why: `${M(CAL_MONTHS[month - 1])} ${e.day}, ${year} is a ${wd}, but it was read under ${e.weekday}` };
        const title = String(e.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!title || !time(e.start) || !time(e.end) || e.start >= e.end) continue;     // one unreadable time drops that event only
        events.push({ date: `${year}-${String(month).padStart(2, '0')}-${String(e.day).padStart(2, '0')}`, title, start: e.start, end: e.end });
    }
    const notes = (Array.isArray(r.notes) ? r.notes : []).map(x => String(x).replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 8);
    return { ok: true, month, year, events, notes };
}

/** One picture → the model's raw answer (an object). Uses the alert reader's key and model. */
async function readCalendarPicture(buf, mediaType, creds = readerCreds()) {
    if (!creds.anthropicKey) throw new Error('no reader key on this machine (calendar pictures are read on the home server)');
    const headers = { authorization: `Bearer ${creds.anthropicKey}`, 'anthropic-version': '2026-10-21' };
    if (creds.anthropicWorkspace) headers['anthropic-workspace-id'] = creds.anthropicWorkspace;
    const { status, text } = await postStatus('https://api.anthropic.com/v1/messages', JSON.stringify({
        model: READER_MODEL,
        max_tokens: 4096,
        system: CAL_SYSTEM,
        messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
            { type: 'text', text: 'Read this calendar.' }
        ] }],
        output_config: { format: { type: 'json_schema', schema: CAL_SCHEMA } }
    }), headers, 90000);
    let body = null;
    try { body = JSON.parse(text); } catch { /* handled below */ }
    if (status !== 200 || !body) throw new Error(`the reader answered HTTP ${status} ${readerScrub(String(body?.error?.message || '')).slice(0, 120)}`);
    if (body.stop_reason !== 'end_turn') throw new Error(`the reader stopped with ${body.stop_reason}`);
    const block = (body.content || []).find(b => b.type === 'text');
    return readerParse(block && block.text);
}
const pictureType = (url) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[(url.split('?')[0].split('.').pop() || '').toLowerCase()] || 'image/png';
const monthLabel = (ym) => { const [y, m] = ym.split('-').map(Number); return `${CAL_MONTHS[m - 1].replace(/^./, c => c.toUpperCase())} ${y}`; };

/** kind 'calendar-image': an arena's month, read from the picture on its page. */
async function fetchCalendarImage(sourceKey, cfg, { get = httpGetText, getBuf = httpGetBuffer, read = readCalendarPicture, today = torontoDateStr(), nowMs = Date.now(), store = path.join(OUTPUT_DIR, CAL_READINGS_FILE) } = {}) {
    const pics = calendarPictures(await get(cfg.url), cfg.url);
    if (!pics.length) return { records: [], state: 'pending', note: 'Its page has no calendar picture right now.' };
    let file = { pictures: {} };
    try { const f = JSON.parse(fs.readFileSync(store, 'utf8')); if (f && f.pictures && typeof f.pictures === 'object') file = f; } catch { /* first run */ }
    const used = [], problems = [];
    let reads = 0;
    for (const url of pics) {
        const name = url.split('/').pop();
        let buf;
        try { buf = await getBuf(url); } catch (e) { problems.push(`${name}: ${errorText(e)}`); continue; }
        if (!Buffer.isBuffer(buf) || !buf.length || buf.length > CAL_IMG_MAX) { problems.push(`${name}: not a picture that can be read`); continue; }
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        let rec = file.pictures[sha];
        if (!rec || (!rec.ok && nowMs - Date.parse(rec.readAt || 0) > CAL_RETRY_MS)) {
            if (reads >= CAL_READ_LIMIT) { problems.push(`${name}: left for the next run`); continue; }
            reads++;
            try {
                const chk = checkCalendarReading(await read(buf, pictureType(url)));
                rec = { url, readAt: new Date(nowMs).toISOString(), by: READER_MODEL, ...chk };
                console.log(chk.ok ? `   🖼️  ${name}: read, ${monthLabel(`${chk.year}-${String(chk.month).padStart(2, '0')}`)}, ${chk.events.length} events` : `   ⚠️ ${name}: not believed (${chk.why})`);
            } catch (e) { problems.push(`${name}: ${errorText(e)}`); continue; }
        }
        rec.url = url;
        rec.seenAt = new Date(nowMs).toISOString();
        file.pictures[sha] = rec;
        if (rec.ok) used.push(rec); else problems.push(`${name}: ${rec.why}`);
    }
    for (const [sha, rec] of Object.entries(file.pictures)) if (!(nowMs - Date.parse(rec.seenAt || rec.readAt || 0) <= CAL_KEEP_MS)) delete file.pictures[sha];
    try { fs.writeFileSync(store, JSON.stringify(file, null, 1)); } catch (e) { console.warn(`   ⚠️ ${CAL_READINGS_FILE}: ${e.message}`); }
    if (problems.length) console.warn(`   ⚠️ ${sourceKey}: ${problems.join('; ')}`);
    if (!used.length) throw new Error(problems.join('; ').slice(0, 300) || 'no calendar picture could be read');

    const until = addDays(today, cfg.daysAhead || 60);
    const seen = new Set(), records = [], skipped = new Set();
    for (const rec of used) for (const e of rec.events) {
        if (e.date < today || e.date > until) continue;
        const keep = (cfg.keep || []).find(k => k.match.test(e.title));
        if (!keep) { skipped.add(e.title); continue; }
        const id = `${e.date}-${e.start}-${e.end}`;
        if (seen.has(id)) continue;
        seen.add(id);
        records.push(externalRecord(cfg, sourceKey, { activity: keep.activity || e.title, date: e.date, startTime: e.start, endTime: e.end, price: 0, idKey: id }));
    }
    if (skipped.size) console.log(`   · ${sourceKey}: also on the picture, not listed: ${[...skipped].slice(0, 4).join(' | ')}`);
    const latest = used.map(r => `${r.year}-${String(r.month).padStart(2, '0')}`).sort().pop();
    const behind = latest < today.slice(0, 7);
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions from the ${monthLabel(latest)} calendar picture`);
    return {
        records,
        state: !records.length && behind ? 'pending' : 'ok',
        note: behind ? `Its page still shows the ${monthLabel(latest)} calendar; the next one is not up yet.` : `Read from its ${monthLabel(latest)} calendar picture.`
    };
}

/* ================= Day grids (Newmarket) and day tables (Aurora) — v3.14 ================= */
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TIME_TO_RE = /(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?\s*(?:to|-|–)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/gi;
const DATE_RANGE_RE = new RegExp(`(${MONTH_NAMES.join('|')})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\s+to\\s+(${MONTH_NAMES.join('|')})\\s+(\\d{1,2}),\\s*(\\d{4})`, 'i');
const ymdOf = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Every "9 to 9:50 a.m." / "12:30 to 1:20 p.m." / "1 p.m. to 2 p.m." in a text → [{ start, end }] in 24 h. Pure. */
function toRanges(text) {
    const out = [];
    const mins = (h, m, ap) => ((+h % 12) + (ap === 'p' ? 12 : 0)) * 60 + (+m || 0);
    const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    for (const m of String(text || '').slice(0, 5000).matchAll(TIME_TO_RE)) {
        if (+m[1] > 12 || +m[4] > 12 || +(m[2] || 0) > 59 || +(m[5] || 0) > 59) continue;
        const eap = m[6].toLowerCase(), sap = m[3] && m[3].toLowerCase();
        const end = mins(m[4], m[5], eap);
        let start = mins(m[1], m[2], sap || eap);
        if (!sap && start >= end) start = mins(m[1], m[2], eap === 'p' ? 'a' : 'p');     // "11 to 12:30 p.m." starts at 11 a.m.
        if (start < end) out.push({ start: hhmm(start), end: hhmm(end) });
    }
    return out;
}
/** "September 9 to December 19, 2026" anywhere in a text → { from, to }. Pure. */
function dateRangeIn(text) {
    const m = DATE_RANGE_RE.exec(String(text || '').slice(0, 2000));
    if (!m) return null;
    const mo = (s) => MONTH_NAMES.indexOf(s.toLowerCase()) + 1;
    const y2 = +m[6], m1 = mo(m[1]), m2 = mo(m[4]);
    return { from: ymdOf(m[3] ? +m[3] : (m1 > m2 ? y2 - 1 : y2), m1, +m[2]), to: ymdOf(y2, m2, +m[5]) };
}
/** "January 8 & 29, February 5 & 26" inside a season → ['2027-01-08', …] (each in the season's year). Pure. */
function datesIn(text, range) {
    const out = [];
    const re = new RegExp(`(${MONTH_NAMES.join('|')})\\s+(\\d{1,2}(?:\\s*(?:&|and)\\s*\\d{1,2})*)`, 'gi');
    const y1 = +range.from.slice(0, 4), y2 = +range.to.slice(0, 4), m1 = +range.from.slice(5, 7);
    for (const m of String(text || '').slice(0, 1000).matchAll(re)) {
        const mo = MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1;
        const y = y1 === y2 || mo >= m1 ? y1 : y2;
        m[2].split(/&|and/).map(d => +d.trim()).filter(d => d >= 1 && d <= 31).forEach(d => out.push(ymdOf(y, mo, d)));
    }
    return out;
}
/** Ages a label says: "18+", "6 yrs & under", "(16-17yrs)", or birth years "2017 to 2019" (in `year`). Pure. */
function agesFromLabel(label, year) {
    const s = String(label || '');
    let m;
    if ((m = /\b((?:19|20)\d\d)\s*(?:to|-|–)\s*((?:19|20)\d\d)\b/.exec(s))) return { ageMin: year - +m[2], ageMax: year - +m[1] };
    if ((m = /\b(\d{1,2})\s*(?:yrs?|years?)?\s*(?:-|–|to)\s*(\d{1,2})\s*(?:yrs?|years?)/i.exec(s))) return { ageMin: +m[1], ageMax: +m[2] };
    if ((m = /\b(\d{1,2})\s*(?:yrs?|years?)\s*(?:&|and)\s*under/i.exec(s))) return { ageMin: null, ageMax: +m[1] };
    if ((m = /\b(\d{1,2})\s*\+/.exec(s))) return { ageMin: +m[1], ageMax: null };
    return { ageMin: null, ageMax: null };
}

/**
 * Newmarket's PDF grids (layout text) → weekly rules. Per arena a line with "Effective <dates>"
 * (and the arena's name, else cfg.grid.venue); a line with the seven day names fixes the columns;
 * below it, activity labels on the left (often over two or three lines) and times in the day
 * columns, two times in one cell joined by "and" or "&". A cell belongs to the label nearest
 * its own middle line. Parsing stops at cfg.grid.stopAt. Pure.
 */
function parseDayGridText(text, cfg) {
    const lines = String(text || '').slice(0, 200000).replace(/\t/g, '    ').split('\n');
    const venueNames = Object.keys(cfg.venues || {});
    const rules = [];
    let block = null;
    const flush = () => { if (block && block.centres) rules.push(...dayGridRules(block, cfg)); block = null; };
    for (let y = 0; y < lines.length; y++) {
        const line = lines[y];
        if (cfg.grid && cfg.grid.stopAt && cfg.grid.stopAt.test(line)) { flush(); break; }
        if (/effective/i.test(line)) {
            const range = dateRangeIn(line);
            if (range) {
                flush();
                block = { venue: venueNames.find(v => line.toLowerCase().includes(v.toLowerCase())) || (cfg.grid && cfg.grid.venue) || null, ...range, centres: null, rows: [] };
                continue;
            }
        }
        if (!block) continue;
        const at = WEEK_DAYS.map(d => line.indexOf(d));
        if (at.every(i => i >= 0)) { block.centres = at.map((x, i) => x + WEEK_DAYS[i].length / 2); continue; }
        if (block.centres && line.trim()) block.rows.push({ y, line });
    }
    flush();
    return rules;
}
function dayGridRules(b, cfg) {
    const width = (b.centres[6] - b.centres[0]) / 6;
    const labelEdge = b.centres[0] - width / 2;
    const isTime = (s) => /\d\s*[ap]\.?\s*m\b|\d\s*[ap]\.?\s*m\./i.test(s);
    const labels = [], cols = b.centres.map(() => []);
    for (const { y, line } of b.rows) {
        for (const m of line.matchAll(/\S+(?: \S+)*/g)) {
            const mid = m.index + m[0].length / 2, tok = m[0];
            if (isTime(tok) || /^(?:and|&)$/i.test(tok)) {
                let c = 0;
                b.centres.forEach((x, i) => { if (Math.abs(x - mid) < Math.abs(b.centres[c] - mid)) c = i; });
                cols[c].push({ y, tok });
            } else if (mid < labelEdge) labels.push({ y, tok });
        }
    }
    // cells: tokens of one column joined by "and" / "&" are one cell
    const cells = [];
    cols.forEach((list, c) => {
        let cur = null;
        list.forEach((t, i) => {
            const joiner = /^(?:and|&)$/i.test(t.tok);
            const prevJoins = i > 0 && /^(?:and|&)$/i.test(list[i - 1].tok);
            if (cur && (joiner || prevJoins)) { cur.toks.push(t.tok); cur.y2 = t.y; return; }
            cur = { c, y1: t.y, y2: t.y, toks: [t.tok] };
            cells.push(cur);
        });
    });
    const real = cells.map(x => ({ ...x, mid: (x.y1 + x.y2) / 2, ranges: toRanges(x.toks.join(' ')) })).filter(x => x.ranges.length);
    // rows: the middle lines of the cells (cells of one row share it), then each label piece joins the nearest row
    const anchors = [];
    [...new Set(real.map(x => x.mid))].sort((a, z) => a - z).forEach(m => { const last = anchors[anchors.length - 1]; if (last != null && m - last <= 1.5) return; anchors.push(m); });
    const near = (y) => anchors.reduce((best, a) => (Math.abs(a - y) < Math.abs(best - y) ? a : best), anchors[0]);
    const labelOf = new Map();
    labels.forEach(l => { const a = near(l.y); if (a == null || Math.abs(a - l.y) > 2.5) return; labelOf.set(a, [...(labelOf.get(a) || []), l.tok]); });
    const year = +String(b.from || '').slice(0, 4) || new Date().getFullYear();
    const out = [];
    real.forEach(x => {
        const label = (labelOf.get(near(x.mid)) || []).join(' ').replace(/\s+/g, ' ').trim();
        if (!label) return;
        const cls = applyProgramRules(cfg, label.replace(/\s*\b\d{1,2}\s*(?:yrs?|years?)\s*(?:&|and)\s*under\b/i, '').trim());
        if (!cls) return;
        const ages = agesFromLabel(label, year);
        x.ranges.forEach(r => out.push({ venue: b.venue, activity: cls.activity, weekday: WEEK_DAYS[x.c], start: r.start, end: r.end,
            ageMin: cls.ageMin ?? ages.ageMin, ageMax: cls.ageMax ?? ages.ageMax, price: cls.price, from: b.from, to: b.to }));
    });
    return out;
}

/**
 * Aurora's skating page → weekly rules (and one-off dated ones). Each <h3> with a date range opens a
 * season; "Location - …" names the arena; each table row is a day ("Sunday", or "Monday, February 15")
 * and lines "1 p.m. to 2 p.m. – Activity", each optionally followed by ">Cancelled: dates". A line
 * starting with a date ("Sunday, October 25 - 10 a.m. to 12 p.m. Halloween Public Skate") is that
 * day only, in place of the weekly one at that time. "*FREE …" makes the starred sessions free. Pure.
 */
function parseAuroraPage(html, cfg) {
    const src = String(html || '').slice(0, 3000000).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
    const text = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8211;|&ndash;/g, '–').replace(/&#8217;|&rsquo;/g, '’').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    const venues = Object.entries(cfg.venues || {});
    const ageRule = (name) => (cfg.ageRules || []).find(r => r.match.test(name)) || {};
    const rules = [];
    const parts = src.split(/<h3\b[^>]*>/i).slice(1);
    for (const part of parts) {
        const end = part.indexOf('</h3>');
        if (end < 0) continue;
        const head = text(part.slice(0, end));
        if (!/drop-?ins?/i.test(head)) continue;
        const range = dateRangeIn(head);
        if (!range) continue;
        const body = part.slice(end);
        const loc = /Location\s*-\s*([^<]{3,120})/i.exec(body);
        const venue = loc ? (venues.find(([, v]) => v.match.test(loc[1])) || [])[0] : null;
        if (!venue) continue;
        const year = +range.from.slice(0, 4);
        const weekly = [];
        for (const tr of body.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
            const tds = tr.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || [];
            if (tds.length < 2) continue;
            const dayCell = text(tds[0]);
            const wd = WEEK_DAYS.find(d => dayCell.toLowerCase().startsWith(d.toLowerCase()));
            if (!wd) continue;                                         // the "Day / Time & Activity" header
            const dated = datesIn(dayCell, range)[0] || null;          // "Monday, February 15": that day only
            const lines = tds[1].split(/<\/p>|<br\s*\/?>/i).map(text).filter(Boolean);
            const free = lines.some(l => /^\*\s*free\b/i.test(l));
            let last = [], marked = [];     // a line ending in ">" is one the next "Cancelled:" line applies to
            for (const line of lines) {
                if (/^>?\s*cancell?ed\s*:/i.test(line)) {
                    const skip = datesIn(line, range);
                    (marked.length ? marked : last).forEach(r => r.except.push(...skip));
                    marked = [];
                    continue;
                }
                const oneOff = new RegExp(`^(${WEEK_DAYS.join('|')}),\\s*(${MONTH_NAMES.join('|')})\\s+\\d{1,2}\\b`, 'i').exec(line);
                const span = toRanges(line);
                if (!span.length) continue;                            // notes
                const name = line.replace(TIME_TO_RE, ' ').replace(/^.*?[–-]\s*/, '').replace(new RegExp(`^(${WEEK_DAYS.join('|')}),\\s*\\S+\\s+\\d{1,2}\\s*`, 'i'), '')
                    .replace(/[^\p{L}\p{N})+]+$/u, '').replace(/^[^\p{L}\p{N}(]+/u, '').replace(/\s+/g, ' ').trim();
                if (!name) continue;
                const cls = applyProgramRules(cfg, name);
                if (!cls) continue;
                const ages = agesFromLabel(name, year), ar = ageRule(name);
                const day = oneOff ? datesIn(oneOff[0], range)[0] : dated;
                const made = span.map(r => ({ venue, activity: cls.activity, weekday: oneOff ? WEEK_DAYS.find(d => d.toLowerCase() === oneOff[1].toLowerCase()) : wd, start: r.start, end: r.end,
                    ageMin: cls.ageMin ?? ages.ageMin ?? ar.ageMin ?? null, ageMax: cls.ageMax ?? ages.ageMax ?? ar.ageMax ?? null,
                    price: free && /\*/.test(line) ? 0 : cls.price, from: day || range.from, to: day || range.to, except: [] }));
                if (day) {
                    // that day only: the weekly session at the same time gives way to it
                    made.forEach(r => weekly.filter(w => w.weekday === r.weekday && w.start === r.start && !w.single).forEach(w => w.except.push(day)));
                    made.forEach(r => { r.single = true; });
                }
                rules.push(...made);
                weekly.push(...made);
                last = made;
                if (/>\s*\*?\s*$/.test(line)) marked.push(...made);
            }
        }
    }
    return rules.map(({ single, ...r }) => r);
}

/* ================= Whitby's arena tables, U of T's term grids — v3.15 ================= */
const DATE_SPAN_RE = new RegExp(`(${MONTH_NAMES.join('|')})\\s+(\\d{1,2}),\\s*(\\d{4})\\s*[-–]\\s*(${MONTH_NAMES.join('|')})\\s+(\\d{1,2}),\\s*(\\d{4})`, 'i');
const SHORT_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8211;|&ndash;/g, '–').replace(/&#8217;|&rsquo;/g, '’').replace(/\s+/g, ' ').trim();
const cellsOf = (tr) => (tr.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(strip);
/** "November 27, December 4, December 25, January 1, 8, and March 26" in a season → dates (a bare day keeps the month before it). Pure. */
function listedDates(text, range) {
    const out = [];
    const y1 = +range.from.slice(0, 4), y2 = +range.to.slice(0, 4), m1 = +range.from.slice(5, 7);
    let mo = 0;
    for (const m of String(text || '').slice(0, 1000).matchAll(new RegExp(`(?:(${MONTH_NAMES.join('|')})\\s+)?(\\d{1,2})\\b`, 'gi'))) {
        if (m[1]) mo = MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1;
        if (!mo || +m[2] < 1 || +m[2] > 31) continue;
        out.push(ymdOf(y1 === y2 || mo >= m1 ? y1 : y2, mo, +m[2]));
    }
    return out;
}

/** Whitby's skating page → weekly rules, one table per arena under its own heading and dates. Pure. */
function parseWhitbyPage(html, cfg) {
    const src = String(html || '').slice(0, 3000000).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
    const venues = Object.entries(cfg.venues || {});
    const rules = [];
    let from = 0;
    for (;;) {
        const a = src.indexOf('<table', from);
        if (a < 0) break;
        const b = src.indexOf('</table>', a);
        if (b < 0) break;
        from = b + 8;
        const head = strip(src.slice(Math.max(0, a - 1500), a)).slice(-400);
        const at = head.lastIndexOf('Skate Schedule');
        if (at < 0) continue;
        const title = head.slice(at);
        const span = DATE_SPAN_RE.exec(title);
        const venue = (venues.find(([, v]) => v.match.test(title)) || [])[0];
        if (!span || !venue) continue;
        const mo = (s) => MONTH_NAMES.indexOf(s.toLowerCase()) + 1;
        const range = { from: ymdOf(+span[3], mo(span[1]), +span[2]), to: ymdOf(+span[6], mo(span[4]), +span[5]) };
        for (const tr of src.slice(a, b).match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
            const c = cellsOf(tr);
            if (c.length < 3) continue;                                  // a section line ("Family Stick and Puck")
            const days = WEEK_DAYS.filter(d => new RegExp(`\\b${d}\\b`, 'i').test(c[0]));
            const span2 = toRanges(c[1]);
            if (!days.length || !span2.length) continue;                 // the header row
            const cls = applyProgramRules(cfg, c[2]);
            if (!cls) continue;
            const ages = agesFromLabel((c[0].match(/\(([^)]*)\)/) || [])[1] || c[2], +range.from.slice(0, 4));
            const qualifier = (c[0].match(/\(([^)]*)\)/) || [])[1];
            const activity = qualifier && !cls.activity.includes(qualifier) ? `${cls.activity} (${qualifier})` : cls.activity;
            const except = listedDates(c[3] || '', range);
            const ar = (cfg.ageRules || []).find(x => x.match.test(activity)) || {};    // ages the fee list gives, where the table does not
            days.forEach(weekday => span2.forEach(r => rules.push({ venue, activity, weekday, start: r.start, end: r.end,
                ageMin: cls.ageMin ?? ages.ageMin ?? ar.ageMin ?? null, ageMax: cls.ageMax ?? ages.ageMax ?? ar.ageMax ?? null, price: cls.price, from: range.from, to: range.to, except })));
        }
    }
    return rules;
}

/**
 * U of T's drop-in ice page → rules: a weekly grid per term (columns Mon … Sun) under a heading with
 * its dates, and grids whose columns carry their own dates ("Mon, Dec 7"; "Wed, 16" keeps the month
 * before it). Dates without a year take the school year around `today`. Pure.
 */
function parseUoftPage(html, cfg, today = torontoDateStr()) {
    const src = String(html || '').slice(0, 3000000).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
    const venue = Object.keys(cfg.venues || {})[0] || cfg.locationName;
    const ty = +today.slice(0, 4), tm = +today.slice(5, 7);
    const yearOf = (mo) => (mo >= 7 ? (tm >= 7 ? ty : ty - 1) : (tm >= 7 ? ty + 1 : ty));      // Sept to June is one school year
    const DAY3 = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const rules = [];
    const sessionsIn = (cell) => {
        const out = [];
        const parts = cell.split(/(?=(?<![\d:])\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?\s*[-–])/i);   // a new session starts at a whole time, never inside "1:00pm"
        parts.forEach(p => { const r = toRanges(p)[0]; if (!r) return; const name = p.replace(TIME_TO_RE, ' ').replace(/\s+/g, ' ').trim(); if (name) out.push({ ...r, name }); });
        return out;
    };
    const rule = (weekday, s, from, to) => {
        const cls = applyProgramRules(cfg, s.name);
        if (!cls) return;
        rules.push({ venue, activity: cls.activity, weekday, start: s.start, end: s.end, ageMin: cls.ageMin, ageMax: cls.ageMax, price: cls.price, from, to, except: [] });
    };
    let from = 0;
    for (;;) {
        const a = src.indexOf('<table', from);
        if (a < 0) break;
        const b = src.indexOf('</table>', a);
        if (b < 0) break;
        from = b + 8;
        const rows = (src.slice(a, b).match(/<tr\b[\s\S]*?<\/tr>/gi) || []).map(cellsOf).filter(r => r.length);
        if (!rows.length || rows[0].length !== 7) continue;
        const head = rows[0];
        const weekly = head.every((h, i) => h.toLowerCase().startsWith(DAY3[i]) && !/\d/.test(h));
        if (weekly) {
            const title = strip(src.slice(Math.max(0, a - 800), a)).slice(-300);
            const m = new RegExp(`(${MONTH_NAMES.join('|')})\\s+(\\d{1,2})\\s+to\\s+(${MONTH_NAMES.join('|')})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\s*$`, 'i').exec(title.replace(/\s*Schedule.*$/i, (x) => x).trim()) ||
                new RegExp(`(${MONTH_NAMES.join('|')})\\s+(\\d{1,2})\\s+to\\s+(${MONTH_NAMES.join('|')})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?`, 'i').exec(title);
            if (!m) continue;
            const m1 = MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1, m2 = MONTH_NAMES.indexOf(m[3].toLowerCase()) + 1;
            const y1 = m[5] && m1 <= m2 ? +m[5] : yearOf(m1), y2 = m[5] ? +m[5] : yearOf(m2);
            const f = ymdOf(y1, m1, +m[2]), t = ymdOf(y2, m2, +m[4]);
            rows.slice(1).forEach(r => r.forEach((cell, i) => sessionsIn(cell).forEach(s => rule(WEEK_DAYS[i], s, f, t))));
            continue;
        }
        // a grid with its own dates on the columns
        let mo = 0;
        const dates = head.map(h => {
            const m = /([A-Za-z]{3})[a-z]*\.?\s*(\d{1,2})\s*$/.exec(h.replace(/^[A-Za-z]{3,9},\s*/, (x) => x)) || /,\s*(?:([A-Za-z]{3})[a-z]*\.?\s*)?(\d{1,2})\s*$/.exec(h);
            const mm = /,\s*([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\s*$/.exec(h) || /,\s*(\d{1,2})\s*$/.exec(h);
            if (!mm) return null;
            if (mm.length === 3) { const k = SHORT_MONTHS.indexOf(mm[1].toLowerCase()); if (k >= 0) mo = k + 1; }
            const day = +(mm.length === 3 ? mm[2] : mm[1]);
            return mo && day ? ymdOf(yearOf(mo), mo, day) : null;
        });
        if (dates.filter(Boolean).length < 5) continue;
        rows.slice(1).forEach(r => r.forEach((cell, i) => { const d = dates[i]; if (!d) return; sessionsIn(cell).forEach(s => rule(WEEK_DAYS[i], s, d, d)); }));
    }
    // a dated grid replaces the weekly sessions on its dates
    const dated = new Set(rules.filter(r => r.from === r.to).map(r => r.from));
    rules.forEach(r => { if (r.from !== r.to) dated.forEach(d => { if (d >= r.from && d <= r.to) r.except.push(d); }); });
    return rules;
}

/** kinds 'whitby' and 'uoft': a page of tables → dated sessions. */
async function fetchTablePage(sourceKey, cfg, { get = httpGetText } = {}) {
    const html = await get(cfg.url);
    const rules = cfg.kind === 'whitby' ? parseWhitbyPage(html, cfg) : parseUoftPage(html, cfg);
    if (!rules.length) { const e = new Error('no schedule tables found on the page'); e.code = 'EMPTY'; throw e; }
    console.log(`   📋 ${rules.length} rules: ${describeRules(rules)}`);
    const records = expandWeekly(cfg, sourceKey, rules);
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions over next ${cfg.daysAhead} days`);
    return records;
}

/** kind 'aurora': the Town of Aurora's skating page → dated sessions. */
async function fetchAurora(sourceKey, cfg, { get = httpGetText } = {}) {
    const rules = parseAuroraPage(await get(cfg.url), cfg);
    if (!rules.length) { const e = new Error('no drop-in tables found on the page'); e.code = 'EMPTY'; throw e; }
    console.log(`   📋 ${rules.length} rules: ${describeRules(rules)}`);
    const records = expandWeekly(cfg, sourceKey, rules);
    console.log(`   ✅ ${sourceKey}: ${records.length} sessions over next ${cfg.daysAhead} days`);
    return records;
}

/** What the last full run recorded per source (meta.json). */
function previousSources() {
    try { return JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'meta.json'), 'utf8')).sources || {}; } catch { return {}; }
}

/**
 * One source, one run → { ok, state, records, at, okAt, … }. Never throws.
 * `fetcher` and `salvage` are injectable for the tests.
 */
async function readSource(key, cfg, was = {}, today = torontoDateStr(), { fetcher = FETCHERS[cfg.kind], salvage = salvageExisting, nowMs = Date.now() } = {}) {
    const now = new Date(nowMs).toISOString();
    const base = { at: now, okAt: was.okAt || null };
    const phase = seasonPhase(cfg, today);
    if (phase && phase.phase === 'out') {
        console.log(`   💤 out of season: not fetched (reading resumes ${phase.resumes})`);
        return { ...base, ok: true, state: 'dormant', records: [], opens: phase.opens, resumes: phase.resumes };
    }
    try {
        if (!fetcher) throw new Error(`unknown source kind '${cfg.kind}'`);
        const out = await fetcher(key, cfg);
        const res = Array.isArray(out) ? { records: out } : (out || { records: [] });
        const keep = {};
        ['note', 'quote', 'season', 'venues', 'manual', 'edited'].forEach(k => { if (res[k] && (!Array.isArray(res[k]) || res[k].length)) keep[k] = res[k]; });
        return { ...base, okAt: now, ok: true, state: res.state || 'ok', records: res.records || [], ...keep };
    } catch (e) {
        // In the weeks before a season, a page with no schedule on it yet is "not posted", not a failure.
        if (phase && phase.phase === 'lead' && e && e.code === 'EMPTY') {
            console.log(`   ⏳ nothing posted yet for the season that starts around ${phase.opens}`);
            return { ...base, okAt: now, ok: true, state: 'pending', records: [], note: 'Nothing is posted for the new season yet.' };
        }
        const message = errorText(e);
        console.warn(`   ⚠️ ${key} failed: ${message}`);
        // A rink that publishes its own hours can close overnight: its last good sessions are
        // only kept for two days. Feeds with dated bookings keep theirs until they pass.
        const hours = cfg.salvageHours ?? ((cfg.kind === 'venue' || cfg.kind === 'manual') ? 48 : null);
        const fresh = hours == null || (was.okAt && (nowMs - new Date(was.okAt).getTime()) <= hours * 3600000);
        return { ...base, ok: false, state: 'failed', error: String(message).slice(0, 200), records: fresh ? salvage(key) : [], unanswered: neverAnswered(e) };
    }
}

/** What meta.json keeps about one source's run (the app's status page reads this). */
function sourceMeta(v) {
    const out = { ok: v.ok, state: v.state, count: v.records.length, at: v.at };
    ['okAt', 'error', 'note', 'quote', 'season', 'opens', 'resumes', 'manual', 'edited'].forEach(k => { if (v[k]) out[k] = v[k]; });
    return out;
}

/**
 * Board arenas whose own site lists public skating again while an older City
 * notice still says "under construction": location id → { on, notice, by }.
 * `external` = this run's results; on the light pass, the last full run's meta.json.
 */
function reopenedNow(external = null) {
    const out = {};
    let prev = null;
    Object.entries(EXTERNAL_SOURCES).forEach(([key, cfg]) => {
        if (!cfg.reopened || !cfg.locationId) return;
        let listed;
        if (external) listed = !!(external[key] && external[key].records && external[key].records.length);
        else { prev = prev || previousSources(); listed = !!(prev[key] && prev[key].count > 0); }
        if (!listed) return;
        let by = '';
        try { by = new URL(cfg.infoUrl).hostname.replace(/^www\./, ''); } catch { /* no site */ }
        out[String(cfg.locationId)] = { on: cfg.reopened.on, notice: cfg.reopened.notice, by };
    });
    return out;
}
/** Mark the City notices a reopened arena has outlived (the app shows them as a note, not a closure). */
function markSuperseded(alerts, reopened) {
    let n = 0;
    (alerts || []).forEach(a => {
        delete a.Superseded;
        const r = reopened[String(a.LocationID)];
        if (!r) return;
        const posted = String(a.PostedDate || '').slice(0, 10);
        if (isYmdStr(posted) && posted < r.on && r.notice.test(`${a.Reason || ''} ${a.Comments || ''}`)) { a.Superseded = { on: r.on, by: r.by }; n++; }
    });
    return n;
}

/* ================= Rinks the City lists twice, and other names =================
 *
 * The City files some outdoor rinks twice: once as a rink asset in its rink
 * inventory (808 "West Mall Rink") and once as the park its sessions and alerts
 * are filed under (2642 "Dennis Flynn Park"). The app then listed two rinks a
 * short walk apart, one of which never had a session. foldTwinRinks() folds the
 * asset entry into the park entry: the park's id stays (sessions, alerts and
 * saved rinks use it), the pad's own coordinates and pad count win, the asset's
 * id is remembered in `alsoIds`, and its name becomes an alias.
 */
const RINK_TWINS = { '808': '2642', '1068': '514' };            // asset id → the location its sessions are filed under (different names)
const RINK_OUTDOOR_AT = { '3492': '189' };                      // the outdoor pads filed under an arena belong to the place next door
const RINK_NAME = { '196': 'Christie Pits Park' };              // the rink inventory misspells it; the sessions do not
/**
 * Other names people use, by location id. Searchable in the app; the first is
 * shown beside the rink's name. Sources: the City's own rink names in its open
 * data, cityrinks.ca's list, and the venues' own sites.
 */
const RINK_AKA = {
    '223':  ['Barbara Ann Scott Ice Trail', 'Barbara Ann Scott Skate Trail'],
    '240':  ['Lake Devo', 'Ryerson Rink', 'Devonian Square'],
    '1089': ['City Hall Rink'],
    '956':  ['North York Civic Centre Rink'],
    '2155': ['Scarborough Civic Centre Rink'],
    '31':   ['Harry Gairey Rink', 'Scadding Rink'],
    '196':  ['Sid Smith Rink', 'Christie Pits'],
    '87':   ['Dufferin Rink'],
    '189':  ['Eglinton Park Rink'],
    '514':  ['Giovanni Caboto Rink', 'J.J.P. Rink'],
    '2642': ['West Mall Rink'],
    '770':  ['Pleasantview Rink'],
    '873':  ['Martingrove Rink'],
    '1860': ['Paul Quarrington Ice Rink'],
    '419':  ['Regent Park South Rink'],
    '466':  ['Colonel Sam Smith Skating Trail'],
    '678':  ['Ledbury Park Rink'],
    '3489': ['Forest Hill Arena'],
    '3495': ['Bill Bolton Arena'],
    '789':  ['Leaside Gardens', 'Leaside Arena'],
    'ext-harbourfront':       ['Skate by the Lake', 'Natrel Rink'],
    'ext-bentway':            ['Under the Gardiner'],
    'ext-evergreen':          ['Brick Works', 'Don Valley Brick Works'],
    'ext-mattamy':            ['Maple Leaf Gardens'],
    'ext-yzd':                ['Downsview', 'The Hangar'],
    'ext-mississauga-square': ['Mississauga City Hall Rink', 'The Rink at Celebration Square']
};

const rinkNameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function metresBetween(a, b) {
    if (a.lat == null || b.lat == null) return Infinity;
    const R = 6371000, toRad = (x) => x * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

/** rinks (as built) + the sessions → rinks with the City's doubles folded together. Pure. */
function foldTwinRinks(rinks, programs = []) {
    const sessions = new Map();
    programs.forEach(p => { if (!p.Source || p.Source === 'city') { const id = String(p['Location ID']); sessions.set(id, (sessions.get(id) || 0) + 1); } });
    const byId = new Map(rinks.map(r => [String(r.locationid), r]));
    const gone = new Set();
    const aka = (r, name) => { if (name && rinkNameKey(name) !== rinkNameKey(r.name)) r.aka = [...new Set([...(r.aka || []), name])]; };

    // outdoor pads the inventory files under an arena, skated at the place next door
    Object.entries(RINK_OUTDOOR_AT).forEach(([arenaId, parkId]) => {
        const arena = byId.get(arenaId), park = byId.get(parkId);
        if (!arena || !park || !(arena.kinds || []).includes('outdoor') || (arena.kinds || []).length < 2) return;
        const moved = (arena.padsBy && arena.padsBy.outdoor) || 1;
        arena.kinds = arena.kinds.filter(k => k !== 'outdoor');
        arena.pads = Math.max(1, (arena.pads || 1) - moved);
        if (arena.kindsSeen) arena.kindsSeen = arena.kindsSeen.filter(k => k !== 'outdoor');
        if (!(park.kinds || []).includes('outdoor')) park.kinds = [...(park.kinds || []), 'outdoor'];
        park.pads = Math.max(park.pads || 1, moved);
    });

    rinks.forEach(asset => {
        const id = String(asset.locationid);
        if (asset.source !== 'city' || asset.fromPrograms || sessions.get(id) || gone.has(id)) return;
        let park = RINK_TWINS[id] ? byId.get(RINK_TWINS[id]) : null;
        if (!park) {
            park = rinks.find(r => r !== asset && r.source === 'city' && r.fromPrograms && !gone.has(String(r.locationid))
                && rinkNameKey(r.name) === rinkNameKey(asset.name)
                && (r.kinds || []).every(k => (asset.kinds || []).includes(k))
                && metresBetween(r, asset) < 600) || null;      // same name, same kind of ice, a short walk apart
        }
        if (!park || gone.has(String(park.locationid))) return;
        park.alsoIds = [...new Set([...(park.alsoIds || []), id])];
        (asset.kinds || []).forEach(k => { if (!park.kinds.includes(k)) park.kinds.push(k); });
        park.pads = Math.max(park.pads || 1, asset.pads || 1);
        if (asset.lat != null) { park.lat = asset.lat; park.lng = asset.lng; }     // the pad itself, not the park's mailing address
        if (!park.postal && asset.postal) park.postal = asset.postal;
        if (!RINK_AKA[String(park.locationid)]) aka(park, asset.name);
        gone.add(id);
    });

    const out = rinks.filter(r => !gone.has(String(r.locationid)));
    out.forEach(r => {
        const id = String(r.locationid);
        if (RINK_NAME[id]) r.name = RINK_NAME[id];
        (RINK_AKA[id] || []).forEach(name => aka(r, name));
        delete r.padsBy;
    });
    return out;
}

/**
 * Every external source, one after the other → { key: result }. A failure is looked at
 * before it is believed (see "Our own network" near the top): wait out an outage of
 * our own, try a second time at the end, and let a last read stand when it was this
 * machine that could not get out. Everything it touches is injectable for the tests.
 */
async function fetchExternalSources({ sources = EXTERNAL_SOURCES, prev = previousSources(), today = torontoDateStr(), read = readSource,
    up = networkUp, wait = waitForNetwork, sleep = pause, now = Date.now } = {}) {
    const bySource = {}, failedAt = {};
    const readIt = (key) => read(key, sources[key], prev[key] || {}, today);
    const attempt = async (key) => {
        let r = await readIt(key);
        if (r.state === 'failed' && !(await up())) {
            console.warn('   📡 this machine is offline: waiting for the network, then reading it again');
            if (await wait()) r = await readIt(key);
            else r.offline = true;
        }
        return r;
    };
    for (const key of Object.keys(sources)) {
        console.log(`\n🌐 External source: ${key}`);
        const r = await attempt(key);
        if (r.state === 'failed') failedAt[key] = now();
        bySource[key] = r;
    }
    // A second try for what failed while the network was fine: one slow answer, one dropped connection.
    for (const key of Object.keys(failedAt)) {
        if (bySource[key].offline) continue;
        const gap = SECOND_TRY_GAP_MS - (now() - failedAt[key]);
        if (gap > 0) await sleep(gap);
        console.log(`\n🔁 Second try: ${key}`);
        bySource[key] = await attempt(key);
    }
    // Still failing. Several unrelated sites that never answered is this machine, not them.
    const failed = Object.keys(bySource).filter(k => bySource[k].state === 'failed');
    const silent = failed.filter(k => bySource[k].offline || bySource[k].unanswered);
    const sites = new Set(silent.map(k => sourceSite(sources[k], bySource[k].error)));
    const ours = new Set(failed.filter(k => bySource[k].offline));
    if (silent.length >= OURS_MIN_SOURCES && sites.size >= OURS_MIN_SITES) silent.forEach(k => ours.add(k));
    const kept = [];
    for (const key of ours) {
        const was = prev[key];
        const lastRead = was && was.at ? new Date(was.at).getTime() : NaN;
        if (!(now() - lastRead <= OFFLINE_KEEP_MS)) continue;      // never read, or too long ago to stand in: it shows as failed
        bySource[key] = keptResult(was, bySource[key]);
        kept.push(key);
    }
    if (kept.length) console.warn(`\n📡 this machine could not get out for ${kept.length} source(s): ${kept.join(', ')}. What their last read said stands.`);
    return bySource;
}

/* ================= Natural ice rinks → natural-ice.json (v3.12) =================
 *
 * Volunteers flood and shovel these on City parkland in cold spells. The City
 * publishes one table a winter, the parks it approved, and nothing about
 * whether there is ice (2017, CityNews: its own outdoor-rink page had 24 of 52
 * rinks wrongly marked closed; a status nobody keeps is worse than none). So
 * this stage reads that table and says which winter it is for, and the app
 * lists the parks with no hours and no open or closed. Each autumn the page
 * still shows last winter's list until the new one is posted (December): the
 * file then says `current: false` and the app says so in words.
 */
const NATURAL_ICE_URL = 'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/ice-snow-activities/public-leisure-skating/natural-ice-rinks/';
const NATURAL_ICE_FILE = 'natural-ice.json';
/** The winter a day belongs to: July 2026 to June 2027 is "2026/2027". */
const winterOf = (today) => { const y = +today.slice(0, 4), m = +today.slice(5, 7); return m >= 7 ? `${y}/${y + 1}` : `${y - 1}/${y}`; };
/**
 * The City's page → { season: '2025/2026', current, next, parks: [{ id, name, address }] }.
 * `current`: the list on the page is for the winter `today` falls in. Throws when there is no list. Pure.
 */
function parseNaturalIcePage(html, today) {
    const src = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
    const m = /(\d{4})\s*\/\s*(\d{4}|\d{2})\s+Approved\s+Locations\b[\s\S]{0,400}?<table\b[^<>]*>([\s\S]*?)<\/table>/i.exec(src);
    if (!m) throw new Error('no approved-locations table on the page');
    const y1 = +m[1], y2 = m[2].length === 2 ? Math.floor(y1 / 100) * 100 + +m[2] : +m[2];
    if (y2 !== y1 + 1) throw new Error(`odd season on the page: ${m[1]}/${m[2]}`);
    const parks = [], seen = new Set();
    for (const row of m[3].matchAll(/<tr\b[^<>]*>\s*<td\b[^<>]*>([\s\S]*?)<\/td>\s*<td\b[^<>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)) {
        const id = (/[?&](?:amp;)?id=(\d{1,6})\b/.exec(row[1]) || [])[1];       // the City's location id, also inside a web-archive link
        const name = lendingPlain(row[1]), address = lendingPlain(row[2]);
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        parks.push({ id, name: name.slice(0, 80), address: address.slice(0, 80) });
    }
    if (parks.length < 5) throw new Error(`only ${parks.length} parks read from the table`);
    const season = `${y1}/${y2}`;
    const next = (/Approved rinks for [^<]{0,160}?\./i.exec(src) || [''])[0];
    return { season, current: season === winterOf(today), next: lendingPlain(next), parks };
}
/** Fetch the page (at most twice a day unless forced), place new parks on the map, write natural-ice.json. Never throws. */
async function fetchNaturalIce({ force = false } = {}) {
    const file = path.join(OUTPUT_DIR, NATURAL_ICE_FILE);
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    if (!force && prev && Array.isArray(prev.parks) && Date.now() - Date.parse(prev.checkedAt || 0) < 12 * 3600 * 1000) {
        console.log(`   ❄️ natural ice: checked ${Math.round((Date.now() - Date.parse(prev.checkedAt)) / 3600000)} h ago (${prev.parks.length} parks, ${prev.season})`);
        return prev;
    }
    try {
        const parsed = parseNaturalIcePage(await httpGetText(NATURAL_ICE_URL), lendingToday());
        const known = new Map(((prev && prev.parks) || []).map(p => [String(p.id), p]));
        let lookups = 60;                       // new addresses a run may look up (the geocoder takes one a second)
        for (const p of parsed.parks) {
            const was = known.get(p.id);
            if (was && was.address === p.address && typeof was.lat === 'number') { p.lat = was.lat; p.lng = was.lng; continue; }
            if (lookups-- <= 0) continue;
            try {
                // the street address first; a park the geocoder cannot find by address is tried by its name
                const inToronto = (g) => g && g.lat > 43.55 && g.lat < 43.90 && g.lng > -79.70 && g.lng < -79.05;   // elsewhere = a wrong match: better no distance than a wrong one
                let g = await geocodeAddress(`${p.address}, Toronto, ON`);
                if (!inToronto(g)) g = await geocodeAddress(`${p.name}, Toronto, ON`);
                if (inToronto(g)) { p.lat = g.lat; p.lng = g.lng; }
            } catch (e) { console.warn(`   📍 natural ice: no coordinates for ${p.name} (${e.message})`); }
        }
        const now = new Date().toISOString();
        const out = { generatedAt: now, checkedAt: now, url: NATURAL_ICE_URL, ...parsed };
        fs.writeFileSync(file, JSON.stringify(out));
        console.log(`   ✅ ${NATURAL_ICE_FILE}: ${out.parks.length} parks approved for ${out.season}${out.current ? '' : ' (last winter\'s list; this winter\'s is not posted yet)'}, ${out.parks.filter(p => p.lat != null).length} placed`);
        return out;
    } catch (e) {
        console.warn(`   ⚠️ natural ice: ${e.message} — keeping the previous file`);
        return prev;
    }
}

/* ================= Main ================= */

/**
 * One row per session the reader can tell apart. The City's export lists a
 * session once per course number — and a two-pad arena running the same
 * program on both pads yields two courses that differ only in Course_ID
 * (Centennial Park Arena, 2026-09-28: 181104 and 181109). Any source can
 * do the same with its own opaque ids, so the rule is general: identity =
 * source + location + date + start + end + title + ages + price, and the
 * copies collapse into the first row, which remembers how many there were
 * (`Copies`) so the app can say "on 2 pads" where that is what it means.
 */
const identityNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function sessionIdentity(p) {
    const loc = p.ExtLocationKey || (p['Location ID'] != null ? String(p['Location ID']) : `name:${identityNorm(p.LocationName)}`);
    return [p.Source || 'city', loc, String(p['Start Date'] || p['Start Date Time'] || '').slice(0, 10), p['Start Time'] || '', p['End Time'] || '',
        identityNorm(p.Activity || p['Course Title']), p['Age Min'] ?? '', p['Age Max'] ?? '', p.Paid ? 1 : 0, p.Price ?? ''].join('|');
}
function dedupePrograms(list) {
    const seen = new Map();
    const out = [];
    for (const p of list) {
        const k = sessionIdentity(p);
        const first = seen.get(k);
        if (first) { first.Copies = (first.Copies || 1) + 1; continue; }
        seen.set(k, p);
        out.push(p);
    }
    const removed = list.length - out.length;
    if (removed) console.log(`   🧹 ${removed} duplicate row${removed === 1 ? '' : 's'} merged (same session under another course id)`);
    return out;
}

/* ================= Venue facts (rentals, admission, helmets) =================
 *
 * The one thing no feed gives us: does this rink rent skates, what does a
 * drop-in cost, is a helmet required. Each venue's own pages say so, in
 * prose. This stage reads them with a local model and keeps only what it
 * can prove:
 *   - crawl: the venue page we already hold plus same-host links that look
 *     like skating/fees/rentals pages (depth 1, ≤ 5 pages);
 *   - narrow: sentences mentioning rentals, admission, fees, prices, helmets;
 *   - extract: Ollama with a JSON schema (structured outputs), temperature 0;
 *   - verify: every field must carry a verbatim quote from the page, every
 *     number in the field must appear in that quote; otherwise the field
 *     becomes unknown. "Per hour" is an ice rental, never an admission.
 * Nothing unverified reaches the app. Self-scheduling: a venue is due when
 * its facts are older than 30 days (3 days after a failure); each full run
 * refreshes a small batch, so the whole set rolls over without a timer.
 * Needs OLLAMA_URL; without it the stage is skipped and old facts stand.
 */
const FACTS_FILE = 'venue-facts.json';
const FACTS_TTL_DAYS = 30, FACTS_RETRY_DAYS = 3, FACTS_BATCH = Number(process.env.FACTS_BATCH || 4);
// Bump when the guards below change: every site on file becomes due again and is re-read on the next runs.
const FACTS_VERSION = 2;
const FACTS_DEBUG = !!process.env.FACTS_DEBUG;
const FACTS_MODEL = () => process.env.OLLAMA_FACTS_MODEL || 'qwen3.5:4b';
// City-owned arenas run by their own boards: not in any City feed, each with a site.
const ARENA_SITES = {
    '3489': 'https://larrygrossmanforesthillarena.com/recreational-skating-hours/',
    '789':  'https://leasidegardens.com/arenas/public-skate-times/',
    '3495': 'https://www.billboltonarena.ca/public-skating',
    '3492': 'https://www.ntarena.ca/',
    '3488': 'https://georgebellarena.com/public-skating',
    '3490': 'https://www.mccormickarena.com/',
    '3494': 'https://tedreevearena.com/',
    '1089': 'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/ice-snow-activities/public-leisure-skating/'
};
const FACT_WORDS = /rental|rent\b|rented|admission|\bfee|price|cost|\$\s?\d|helmet|free of charge|no charge|free skat|free admission|free public|free drop|per person|per pair|per skater|drop-in|public skat|pleasure skat|leisure skat|recreational skat/i;
const LINK_WORDS = /skat|rental|rent|admission|fee|price|rate|drop-?in|public|hours|schedule|visit|faq/i;

const FACTS_SCHEMA = {
    type: 'object',
    properties: {
        rentals: { type: 'object', properties: {
            available: { type: 'string', enum: ['yes', 'no', 'unknown'] },
            price: { type: ['number', 'null'] },
            unit: { type: 'string', enum: ['per pair', 'per person', 'per 2 hours', 'per session', 'per hour', 'unknown'] },
            quote: { type: 'string' } }, required: ['available', 'price', 'unit', 'quote'] },
        admission: { type: 'object', properties: {
            price: { type: ['number', 'null'] },
            unit: { type: 'string', enum: ['per person', 'per session', 'per 2 hours', 'per hour', 'free', 'unknown'] },
            quote: { type: 'string' } }, required: ['price', 'unit', 'quote'] },
        helmets: { type: 'object', properties: {
            rule: { type: 'string', enum: ['required', 'required under age', 'recommended', 'unknown'] },
            age: { type: ['number', 'null'] },
            quote: { type: 'string' } }, required: ['rule', 'age', 'quote'] }
    },
    required: ['rentals', 'admission', 'helmets']
};
const FACTS_PROMPT = (venue, text) => `You read a skating venue's web pages and report three facts about PUBLIC / LEISURE / RECREATIONAL skating (drop-in skating by the public), nothing else.
Rules:
- Use only the TEXT below. If the text does not say, answer "unknown" (or null) — never guess.
- Every "quote" must be copied word for word from the TEXT, one sentence or line that contains the fact. Empty quote = unknown.
- rentals = renting SKATES to skaters. Ice rentals (renting the rink by the hour), helmet rentals and skate sharpening are NOT skate rentals.
- admission = what one skater pays to join a public skating session. A price "per hour" is an ice rental, not admission: report unit "per hour" only if the text truly charges skaters per hour. If sessions are free, unit is "free" and price 0.
- helmets: "required" (everyone), "required under age" (give the age), "recommended", or "unknown".
- Ignore prices for shinny, hockey, ticket ice, lessons, camps, parties and ice rentals: they are not public skating admission.
- Write each quote without surrounding quotation marks.
Venue: ${venue}
TEXT:
${text}`;

// Comparison form of a quote: case, curly quotes, dash variants and spacing
// never decide a match, and a model's habit of wrapping the quote in quotation
// marks is forgiven.
const normQuote = (s) => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().replace(/^["']+|["']+$/g, '').trim();
const cleanQuote = (s) => String(s || '').trim().replace(/^["“”']+|["“”']+$/g, '').trim();
// Guards the model cannot talk its way past: wording that marks a sentence as
// about something other than skating admission or skate rentals.
const NOT_ADMISSION_RE = /shinny|hockey|player|stick|puck|goalie|ticket ice|lesson|camp|birthday|party|league|tournament|per hour|\bpass(?:es)?\b|membership|\bmembers?\b|monthly|annual|per month|per year|punch|\bvisits?\b|\bevents?\b|try-on|equipment|giveaway|festival|clinic/i;
// "Free" must mean the price. "Adult Free Skate" is a programme name (unstructured skating, often $5+)
// and "Free Skating Equipment Try-On Events" is an event; neither says admission is free.
const FREE_ADMISSION_RE = /free (?:of charge|admission|entry|to (?:skate|attend|join|the public))|no (?:charge|cost|fee|admission fee)|admission:?\s*(?:is\s*)?free|(?:is|are|'s|remains?) free\b|free (?:public|leisure|pleasure|recreational|drop-in|family|community|open) skat|skat\w* (?:is|are) free/i;
// ...and it must actually be about skating admission, not a bare price tier ("Older Adult: $34.86")
const ADMISSION_CONTEXT_RE = /skat|admission|drop-in|per person|per skater|per visit/i;
const NOT_SKATE_RENTAL_RE = /ice rental|rent the ice|arena rental|facility rental|room rental|hall rental|per hour|hourly/i;
const NO_RENTALS_RE = /\b(?:do not|don'?t|does not|doesn'?t|cannot|can'?t|no longer|not)\b[^.]{0,40}\b(?:offer|provide|have|rent)\b[^.]{0,40}\brental|\brentals?\b[^.]{0,20}\b(?:not|no longer) (?:available|offered)|\bno (?:skate |skates? )?rentals?\b/i;
const YES_RENTALS_RE = /\b(?:offer|provide|have|available)\b[^.]{0,40}\b(?:skate )?rentals?\b|\brentals?\b[^.]{0,20}\b(?:are |is )?available|\$\s?\d+(?:\.\d+)?[^.]{0,20}\bper pair\b|rent(?:al)? skates?\b/i;
// A helmet sentence counts only when it is plainly about skating sessions
// (all skaters / patrons / "children 12 and under"), not a lesson, camp or
// shinny rule that a city's page lists a paragraph away.
const HELMET_CONTEXT_RE = /\b(?:all skaters|every skater|all patrons|patrons|public skat|leisure skat|pleasure skat|recreational skat|family skat|community skat|drop-in|children (?:\d+|under|aged|age)|kids (?:\d+|under)|under (?:the age of )?\d+|\d+ (?:and|or|&) (?:under|younger)|everyone|all ages)\b/i;
const NOT_HELMET_RE = /lesson|learn[- ]to|\bclass(?:es)?\b|camp|clinic|shinny|hockey (?:program|league|skills)|stick|puck|goalie|birthday|party/i;
/** "12 and under" → 12, "under the age of 6" → 5, "ages up to 10" → 10; null when the quote gives no age. */
function helmetMaxAge(quote) {
    const q = String(quote || '').toLowerCase();
    let m;
    if ((m = q.match(/(\d{1,2})\s*(?:years?(?: of age| old)?)?\s*(?:and|or|&)\s*(?:under|younger|below)/))) return +m[1];
    if ((m = q.match(/(?:aged?|ages?)\s*(?:up to|to)\s*(\d{1,2})/))) return +m[1];
    if ((m = q.match(/(?:under|below|younger than|less than)\s*(?:the age of\s*)?(\d{1,2})/))) return +m[1] - 1;
    return null;
}
function quoteVerified(quote, corpus) {
    const q = normQuote(quote);
    return q.length >= 12 && corpus.includes(q);
}
function numbersIn(s) { return (String(s || '').match(/\d+(?:\.\d+)?/g) || []).map(Number); }
function verifyField(obj, corpus, numericKeys) {
    if (!obj || typeof obj !== 'object') return null;
    if (!quoteVerified(obj.quote, corpus)) return null;
    const nums = numbersIn(obj.quote);
    for (const k of numericKeys) {
        if (obj[k] && !nums.some(n => Math.abs(n - obj[k]) < 0.005)) return null;   // a number the page never said (0 = free, nothing to find)
    }
    return obj;
}

/** "Skate rentals at Chic Murray Arena & Paul Coffey Arena" → ['Chic Murray Arena', 'Paul Coffey Arena']; [] when no place is named. */
function namedPlaces(quote) {
    const re = /([A-Z][\w'&.-]+(?:\s+(?:[A-Z][\w'&.-]+|of|the|and|&)){0,5})\s+(Arenas?|Centre|Center|Rinks?|Park|Square|Gardens|Complex|Pavilion)\b/g;
    const out = []; let m;
    while ((m = re.exec(String(quote || '')))) out.push(`${m[1]} ${m[2]}`);
    return out;
}
const PLACE_STOP = new Set(['arena', 'arenas', 'centre', 'center', 'community', 'memorial', 'recreation', 'park', 'rink', 'rinks', 'complex', 'gardens', 'sports', 'pavilion', 'the', 'and']);
/** A sentence that names specific rinks applies only to the rinks it names (a city's page serves every rink in that city). */
function appliesToVenue(field, venueName) {
    const places = namedPlaces(field.quote);
    if (!places.length) return true;
    const words = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 4 && !PLACE_STOP.has(w));
    const mine = new Set(words(venueName));
    return places.some(pl => words(pl).some(w => mine.has(w)));
}

/** Same-host links on a page that look like they lead to skating, fees or rentals. */
function candidateLinks(html, baseUrl) {
    const out = new Map();
    const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.size < 40) {
        let href;
        try { href = new URL(m[1], baseUrl); } catch { continue; }
        if (href.hostname !== new URL(baseUrl).hostname) continue;
        if (/\.(pdf|jpe?g|png|gif|svg|mp4|zip)(\?|$)/i.test(href.pathname)) continue;
        const label = stripHtml(m[2] || '').slice(0, 80);
        if (LINK_WORDS.test(label) || LINK_WORDS.test(href.pathname)) out.set(href.href.replace(/\/$/, ''), label);
    }
    return [...out.keys()];
}

/** Page text with one line per block element (headings and list items stay separate sentences). */
function pageLines(html) {
    return stripHtml(html.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th|\/section|\/article|\/dd|\/dt)\b[^>]*>/gi, ' ¶ '))
        .split('¶').map(l => l.trim()).filter(Boolean).join('\n');
}

/** Sentences that talk about rentals, fees, admission or helmets, from one or more pages. */
function factWindows(pages) {
    const seen = new Set(), out = [];
    const push = (url, t) => {
        t = t.trim();
        if (t.length < 15 || !FACT_WORDS.test(t)) return;
        const k = normQuote(t);
        if (seen.has(k)) return;
        seen.add(k); out.push({ url, t });
    };
    pages.forEach(({ url, text }) => {
        text.split('\n').forEach(line => {
            line.split(/(?<=[.!?])\s+(?=[A-Z])/).forEach(sentence => {
                if (sentence.length <= 500) return push(url, sentence);
                // a long run without punctuation (schedule blocks): a window around each mention
                const re = new RegExp(FACT_WORDS.source, 'gi');
                let m;
                while ((m = re.exec(sentence))) push(url, sentence.slice(Math.max(0, m.index - 160), m.index + 200));
            });
        });
    });
    return out.slice(0, 60);
}

/** A field whose quote names exactly one dollar amount, but the model left price empty: use that amount. */
function fillPrice(field) {
    if (!field || field.price != null) return field;
    const amounts = (field.quote.match(/\$\s?(\d+(?:\.\d{1,2})?)/g) || []).map(a => Number(a.replace(/[^\d.]/g, '')));
    if (amounts.length === 1) field.price = amounts[0];
    return field;
}

async function readVenuePages(startUrl) {
    const pages = [];
    const html = await httpGetText(startUrl);
    pages.push({ url: startUrl, text: pageLines(html) });
    const links = candidateLinks(html, startUrl).filter(u => u !== startUrl.replace(/\/$/, '')).slice(0, 5);
    for (const u of links) {
        try { pages.push({ url: u, text: pageLines(await httpGetText(u)) }); } catch {}
    }
    return pages;
}

async function extractFacts(venueName, windows) {
    const ollama = (process.env.OLLAMA_URL || '').replace(/\/+$/, '');
    const text = windows.map(w => w.t).join('\n').slice(0, 7000);
    const res = await postText(`${ollama}/api/chat`, JSON.stringify({
        model: FACTS_MODEL(), stream: false, think: false, format: FACTS_SCHEMA,
        options: { temperature: 0, num_ctx: 8192 },
        messages: [{ role: 'user', content: FACTS_PROMPT(venueName, text) }]
    }), {}, 180000);
    const parsed = JSON.parse(res);
    if (parsed.error) throw new Error(`Ollama: ${parsed.error}`);
    const content = parsed.message?.content ?? parsed.response ?? '';
    if (FACTS_DEBUG) console.log(`   🔍 ${venueName}: ${windows.length} windows, ${text.length} chars → ${String(content).replace(/\s+/g, ' ').slice(0, 600)}`);
    return JSON.parse(String(content).replace(/^```json\s*|```$/g, ''));
}

function factsDue(rec, now) {
    if (!rec || !rec.checkedAt || rec.factsVersion !== FACTS_VERSION) return true;
    const age = (now - new Date(rec.checkedAt).getTime()) / 86400000;
    return age > (rec.error ? FACTS_RETRY_DAYS : FACTS_TTL_DAYS);
}

/**
 * Refresh the facts for every due venue (or the first FACTS_BATCH of them).
 * `rinks` = this run's rink inventory; venues with a website qualify.
 */
async function fetchVenueFacts(rinks, { all = false } = {}) {
    if (!process.env.OLLAMA_URL) { console.log('\n🏷️  Venue facts: no OLLAMA_URL, keeping the previous file'); return null; }
    const file = path.join(OUTPUT_DIR, FACTS_FILE);
    let store = { venues: {} };
    try { store = JSON.parse(fs.readFileSync(file, 'utf8')); store.venues ||= {}; } catch {}
    const now = Date.now();
    // one extraction per page: a city's skating page serves every rink of that city
    const groups = new Map();
    rinks.filter(r => r.website && !r.noFacts).forEach(r => {
        const url = String(r.website).trim();
        if (!groups.has(url)) groups.set(url, []);
        groups.get(url).push({ key: String(r.locationid), name: r.name, kinds: r.kinds || [] });
    });
    const targets = [...groups].map(([url, venues]) => ({ url, venues, name: venues.length === 1 ? venues[0].name : `${venues.length} rinks on ${new URL(url).hostname}` }));
    const due = targets.filter(t => t.venues.some(v => factsDue(store.venues[v.key], now)));
    const batch = all ? targets : due.slice(0, FACTS_BATCH);
    console.log(`\n🏷️  Venue facts: ${rinks.filter(r => r.website).length} venues on ${targets.length} sites, ${due.length} sites due, refreshing ${batch.length} (model ${FACTS_MODEL()})`);
    let refreshed = 0;
    for (const t of batch) {
        const rec = { url: t.url, checkedAt: new Date().toISOString(), model: FACTS_MODEL() };
        const save = () => {
            const multi = t.venues.length > 1;   // a city's page serving several rinks
            t.venues.forEach(v => {
                const mine = { name: v.name, ...rec, factsVersion: FACTS_VERSION };
                // on a shared page, rentals/admission count only when the sentence names this rink
                // ("rentals at Chic Murray Arena & Paul Coffey Arena" yes; "the pro shop rents skates" no)
                if (mine.rentals && (!appliesToVenue(mine.rentals, v.name) || (multi && !namedPlaces(mine.rentals.quote).length))) delete mine.rentals;
                if (mine.admission && (!appliesToVenue(mine.admission, v.name) || (multi && !namedPlaces(mine.admission.quote).length))) delete mine.admission;
                // "free skating on our outdoor rinks" says nothing about an arena
                const outdoorOnly = (f) => f && /outdoor/i.test(f.quote) && !v.kinds.includes('outdoor');
                if (outdoorOnly(mine.rentals)) delete mine.rentals;
                if (outdoorOnly(mine.admission)) delete mine.admission;
                if ('verified' in rec) mine.verified = !!(mine.rentals || mine.admission || mine.helmets);
                store.venues[v.key] = mine;
            });
            store.generatedAt = new Date().toISOString();
            fs.writeFileSync(file, JSON.stringify(store));   // progress-safe: a crash keeps what was done
        };
        try {
            const pages = await readVenuePages(t.url);
            const windows = factWindows(pages);
            rec.pages = pages.map(p => p.url);
            if (!windows.length) { rec.none = true; save(); console.log(`   · ${t.name}: nothing about fees or rentals on ${pages.length} page(s)`); continue; }
            const corpus = normQuote(windows.map(w => w.t).join('\n'));
            const urlFor = (quote) => (windows.find(w => normQuote(w.t).includes(normQuote(quote))) || {}).url || t.url;
            const raw = await extractFacts(t.name, windows);
            let rentals = fillPrice(verifyField(raw.rentals, corpus, ['price']));
            let admission = fillPrice(verifyField(raw.admission, corpus, ['price']));
            let helmets = verifyField(raw.helmets, corpus, ['age']);
            if (helmets && (NOT_HELMET_RE.test(helmets.quote) || !HELMET_CONTEXT_RE.test(helmets.quote))) helmets = null;   // a lesson/camp rule, or no skating context
            // "mandatory for everyone" outranks an age the model picked from the same sentence
            if (helmets && /mandatory for (?:everyone|all)|required for (?:all|everyone)|all (?:skaters|participants|patrons) (?:must|are required to|need to) wear|everyone must wear/i.test(helmets.quote)) helmets.rule = 'required';
            if (rentals && NOT_SKATE_RENTAL_RE.test(rentals.quote)) rentals = null;          // the ice, not skates
            if (admission && (NOT_ADMISSION_RE.test(admission.quote) || !ADMISSION_CONTEXT_RE.test(admission.quote))) admission = null;   // shinny / passes / lessons, or no skating context
            if (admission && admission.unit === 'free' && !FREE_ADMISSION_RE.test(admission.quote)) admission = null;                      // "free skate" the programme, not the price
            if (rentals) {
                // the quote outranks the model's yes/no: a plain "we do not offer skate rentals" is a no
                if (NO_RENTALS_RE.test(rentals.quote)) { rentals.available = 'no'; rentals.price = null; rentals.unit = 'unknown'; }
                else if (rentals.available === 'unknown' && YES_RENTALS_RE.test(rentals.quote)) rentals.available = 'yes';
                // "Every Saturday, enjoy FREE skate rentals" is not a price of $0: free rentals come with a day or a
                // condition, and the rest of the week costs money. Rentals yes, price not stated.
                if (rentals.price === 0) { rentals.price = null; rentals.unit = 'unknown'; }
            }
            // sanity: a per-hour or $40+ 'rental' is the ice, not a pair of skates
            if (rentals && rentals.available !== 'unknown' && rentals.unit !== 'per hour' && !(rentals.price > 20)) rec.rentals = { available: rentals.available, price: rentals.price, unit: rentals.unit, quote: cleanQuote(rentals.quote), url: urlFor(rentals.quote) };
            if (admission && admission.unit !== 'unknown' && admission.unit !== 'per hour' && !(admission.price > 15)) rec.admission = { price: admission.unit === 'free' ? 0 : admission.price, unit: admission.unit, quote: cleanQuote(admission.quote), url: urlFor(admission.quote) };
            // the age limit is re-read from the quote itself ("12 and under" ≠ "under 12"); none found → stated without a number
            if (helmets && helmets.rule !== 'unknown') rec.helmets = { rule: helmets.rule, maxAge: helmets.rule === 'required under age' ? helmetMaxAge(helmets.quote) : null, quote: cleanQuote(helmets.quote), url: urlFor(helmets.quote) };
            rec.verified = !!(rec.rentals || rec.admission || rec.helmets);
            console.log(`   ✓ ${t.name}: ${rec.rentals ? `rentals ${rec.rentals.available}${rec.rentals.price != null ? ` $${rec.rentals.price} ${rec.rentals.unit}` : ''}` : 'rentals ?'} · ${rec.admission ? `admission ${rec.admission.unit === 'free' ? 'free' : `$${rec.admission.price} ${rec.admission.unit}`}` : 'admission ?'} · ${rec.helmets ? `helmets ${rec.helmets.rule}${rec.helmets.maxAge != null ? ` ≤${rec.helmets.maxAge}` : ''}` : 'helmets ?'}`);
            refreshed++;
        } catch (e) {
            rec.error = e.message.slice(0, 160);
            console.warn(`   ⚠️ ${t.name}: ${rec.error}`);
        }
        save();
    }
    const verified = Object.values(store.venues).filter(v => v.verified).length;
    console.log(`   ✅ ${FACTS_FILE}: ${Object.keys(store.venues).length} venues on file, ${verified} with verified facts, ${refreshed} refreshed now`);
    return { venues: Object.keys(store.venues).length, verified, refreshed, due: due.length };
}

/* ================= Free skates → lending.json (v3.11) =================
 *
 * The City's Skate Lending Library (with Desjardins) is a van that brings free
 * skates, helmets and skating aids to one rink a day. Its schedule exists in
 * exactly one place: a hand-edited HTML table on a toronto.ca page. There is
 * no feed, so the page is read here, defensively:
 *   - a row counts only if its date resolves to a day whose weekday matches
 *     the one written in the row (catches a wrong year and typos);
 *   - times come in half a dozen spellings ("4 to 8 p.m.", "Noon to 4 p.m.",
 *     "1:45 to 3:45 p.m."); a start without a.m./p.m. is the latest reading
 *     that still falls before the end;
 *   - each stop links a City location id, the same id rinks.json is keyed by;
 *   - a page with no table is "not posted yet", which is a normal state every
 *     autumn, not an error; a page that cannot be fetched leaves the last
 *     good file in place.
 * Alongside the van, a short list of other free options that were read on
 * their own pages (each entry says where and when it was checked, and expires
 * by itself at the end of its season).
 */
const LENDING_FILE = 'lending.json';
const LENDING_URL = 'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/ice-snow-activities/public-leisure-skating/skate-lending-library/';
const LENDING_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const LENDING_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/* Other free ways to get on skates, each confirmed on the page named (checked = the day it was read). */
const LENDING_ALSO = [
    { id: 'harbourfront-saturdays', place: 'Harbourfront Centre rink', address: '235 Queens Quay W, Toronto', what: 'Free skate rentals every Saturday, while quantities last', rink: 'ext-harbourfront', days: [6], start: '2026-11-21', end: '2027-02-27', url: 'https://harbourfrontcentre.com/program/skate/', checked: '2026-11-12' },
    { id: 'bentway-thursdays', place: 'The Bentway skate trail', address: '250 Fort York Blvd, Toronto', what: 'Free skate rentals on Thursdays. Bring government ID; a waiver is signed on site', rink: 'ext-bentway', days: [4], from: '17:00', to: '20:00', start: '2027-01-07', end: '2027-02-25', url: 'https://thebentway.ca/event/billy-bishop-free-rental-thursdays-2/', checked: '2026-11-12' },
    { id: 'college-park-opening', place: 'College Park ice trail', address: '420 Yonge St, Toronto', what: 'Free skate lending at the opening event, while supplies last', rink: '223', date: '2026-12-05', from: '14:00', to: '18:00', start: '2026-12-05', end: '2026-12-05', url: 'https://downtownyonge.com/basit2025/', checked: '2026-11-12' },
    { id: 'burlington-skate-hub', place: 'Skate Hub, Appleby Ice Centre (Arena A)', address: '1201 Appleby Line, Burlington', what: 'Free skates to take: first come, first served, no sign-out, keep them as long as you need', rink: 'ext-burlington-appleby-ice-centre', start: '2026-11-01', end: '2027-04-30', url: 'https://www.burlington.ca/recreation/skating/', checked: '2026-11-12' }
];
const lendingPlain = (html) => String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&(?:rsquo|lsquo|#8217|#8216|#39|apos);/g, "'")
    .replace(/&(?:ndash|mdash|#8211|#8212);/g, '-').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
const lendingYmd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lendingToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TORONTO_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** "4 to 8 p.m." / "Noon to 4 p.m." / "10 a.m. to 4 p.m." → { from: "16:00", to: "20:00" }, or null. */
function parseLendingTime(text) {
    const t = lendingPlain(text).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
    const m = /^(noon|\d{1,2}(?::\d{2})?)\s*(am|pm)?\s*(?:to|-)\s*(noon|\d{1,2}(?::\d{2})?)\s*(am|pm)?$/.exec(t);
    if (!m) return null;
    const mins = (clock, half) => {
        if (clock === 'noon') return 720;
        const [h, mm = '0'] = clock.split(':');
        const hour = Number(h), minute = Number(mm);
        if (hour < 1 || hour > 12 || minute > 59) return null;
        return ((hour % 12) + (half === 'pm' ? 12 : 0)) * 60 + minute;
    };
    if (m[3] !== 'noon' && !m[4]) return null;                    // an end with no a.m./p.m. is a guess: refuse
    const end = mins(m[3], m[4]);
    if (end === null) return null;
    let start = null;
    if (m[1] === 'noon') start = 720;
    else {
        const am = mins(m[1], 'am'), pm = mins(m[1], 'pm');
        if (am === null) return null;
        // as written if that works; otherwise (unmarked, or a typo like "10 p.m. to 4 p.m.") the latest reading before the end
        const written = m[2] ? mins(m[1], m[2]) : null;
        start = written !== null && written < end ? written : [pm, am].find(v => v < end);
        if (start === undefined) return null;
    }
    const length = end - start;
    if (length < 30 || length > 12 * 60) return null;
    const hhmm = (v) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
    return { from: hhmm(start), to: hhmm(end) };
}
/** "Friday, January 2" (+ optional year, + optional note) → "2026-01-02" for the year whose weekday agrees. */
function parseLendingDate(text, today, headingYear) {
    const t = lendingPlain(text).toLowerCase();
    const m = new RegExp(`(?:(${LENDING_DAYS.join('|')})\\w*,?\\s+)?(${LENDING_MONTHS.join('|')})\\s+(\\d{1,2})(?:,?\\s+(20\\d\\d))?`).exec(t);
    if (!m) return null;
    const month = LENDING_MONTHS.indexOf(m[2]) + 1, day = Number(m[3]);
    const weekday = m[1] ? LENDING_DAYS.indexOf(m[1]) : -1;
    const thisYear = Number(today.slice(0, 4));
    // years to try, most trusted first: the one in the cell, the one in the heading, then around today
    const years = [m[4] && Number(m[4]), headingYear, thisYear, thisYear + 1, thisYear - 1].filter(Boolean);
    const valid = (y) => { const d = new Date(Date.UTC(y, month - 1, day)); return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null; };
    for (const y of [...new Set(years)]) {
        const d = valid(y);
        if (!d) continue;
        if (weekday >= 0 && d.getUTCDay() !== weekday) continue;
        return lendingYmd(y, month, day);
    }
    return null;
}
/** The schedule page → { status: 'scheduled' | 'soon' | 'none', startsOn, modified, stops, skipped }. Pure. */
function parseLendingPage(html, today = lendingToday()) {
    const page = String(html || '');
    const at = page.search(/id=["']accordion-schedule["']/i);
    const block = at >= 0 ? page.slice(at) : page;
    const stops = [], skipped = [];
    let headingYear = null;
    const walker = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>|<table\b[\s\S]*?<\/table>/gi;
    let part;
    while ((part = walker.exec(block))) {
        if (part[1] !== undefined) { const y = /(20\d\d)\s+schedule/i.exec(lendingPlain(part[1])); if (y) headingYear = Number(y[1]); continue; }
        const rows = part[0].match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
        const head = rows.length ? lendingPlain(rows[0]).toLowerCase() : '';
        if (!(head.includes('date') && head.includes('location') && head.includes('time'))) continue;
        for (const row of rows.slice(1)) {
            const cells = (row.match(/<t[dh]\b[^>]*>[\s\S]*?(?=<\/t[dh]>|<t[dh]\b|<\/tr>)/gi) || []).map(c => c.replace(/^<t[dh]\b[^>]*>/i, ''));
            if (cells.length < 3) continue;
            const date = parseLendingDate(cells[0], today, headingYear);
            const time = parseLendingTime(cells[2]);
            const id = (/location\/\?id=(\d+)/i.exec(cells[1]) || /\/complex\/(\d+)\//i.exec(cells[1]) || [])[1] || null;
            // The cell is "name, descriptor, address" with paragraph or line breaks in no fixed place,
            // sometimes none at all ("…ice rink276 Davisville Ave."). The address is whatever starts
            // at the first street number; everything before it names the place.
            const whole = lendingPlain(cells[1].replace(/<\/p>|<p\b[^>]*>|<br\s*\/?>/gi, ' '));
            const cut = /(?:^|[\sa-z)])(\d{1,5}\s+[A-Z])/.exec(whole);
            const at = cut ? cut.index + cut[0].length - cut[1].length : -1;
            const place = (at >= 0 ? whole.slice(0, at) : whole).replace(/\s+,/g, ',').replace(/[\s,]+$/, '').trim();
            const address = at >= 0 ? whole.slice(at).trim() : '';
            const note = lendingPlain(cells[0]).replace(new RegExp(`^(?:(?:${LENDING_DAYS.join('|')})\\w*,?\\s+)?(?:${LENDING_MONTHS.join('|')})\\s+\\d{1,2}(?:,?\\s+20\\d\\d)?`, 'i'), '').trim();
            if (!date || !time || !place) { skipped.push(lendingPlain(row).slice(0, 140)); continue; }
            stops.push({ date, from: time.from, to: time.to, id, place: place.slice(0, 120), address: address.slice(0, 120), ...(note ? { note: note.slice(0, 80) } : {}) });
        }
    }
    const seen = new Set();
    const unique = stops.filter(s => { const k = `${s.date}|${s.from}|${s.id || s.place}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => (a.date + a.from < b.date + b.from ? -1 : 1));
    const text = lendingPlain(block);
    const starts = new RegExp(`starting\\s+(${LENDING_MONTHS.join('|')})\\s+(\\d{1,2}),?\\s+(20\\d\\d)`, 'i').exec(text);
    const mod = new RegExp(`date modified:\\s*(${LENDING_MONTHS.join('|')})\\s+(\\d{1,2}),?\\s+(20\\d\\d)`, 'i').exec(lendingPlain(page));
    const ymd = (m) => m ? lendingYmd(Number(m[3]), LENDING_MONTHS.indexOf(m[1].toLowerCase()) + 1, Number(m[2])) : null;
    return {
        status: unique.length ? 'scheduled' : (/schedule is coming soon/i.test(text) ? 'soon' : 'none'),
        startsOn: ymd(starts), modified: ymd(mod), stops: unique, skipped
    };
}
/**
 * Which rink of ours is a stop at? The City's id when rinks.json has it; else the
 * street address (the same place sometimes carries a park id in one season and a
 * complex id in the next). Returns the rinks.json key, or null.
 */
const lendingAddrKey = (a) => String(a || '').toLowerCase().replace(/[.,]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
function lendingRinkKey(stop, rinks) {
    const list = Array.isArray(rinks) ? rinks : [];
    if (stop.id && list.some(r => String(r.locationid) === String(stop.id))) return String(stop.id);
    const twin = stop.id ? list.find(r => (r.alsoIds || []).includes(String(stop.id))) : null;   // v3.12: the City's second id for the same rink
    if (twin) return String(twin.locationid);
    const want = lendingAddrKey(stop.address);
    if (!/^\d+ \S/.test(want)) return null;
    const hit = list.filter(r => lendingAddrKey(r.address) === want);
    return hit.length === 1 ? String(hit[0].locationid) : null;       // two rinks at one address key: do not guess
}
/** Fetch the page (at most every 6 hours unless forced) and write lending.json. Never throws. */
async function fetchLending({ force = false, rinks = null } = {}) {
    if (!rinks) { try { rinks = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'rinks.json'), 'utf8')).rinks || []; } catch { rinks = []; } }
    const file = path.join(OUTPUT_DIR, LENDING_FILE);
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    const today = lendingToday();
    const also = LENDING_ALSO.filter(a => a.end >= today);
    if (!force && prev && prev.van && Date.now() - Date.parse(prev.checkedAt || 0) < 6 * 3600 * 1000 && JSON.stringify(prev.also) === JSON.stringify(also)) {
        console.log(`   ⛸ lending: checked ${Math.round((Date.now() - Date.parse(prev.checkedAt)) / 60000)} min ago (${prev.van.stops.length} stops, ${prev.van.status})`);
        return prev;
    }
    let van = prev && prev.van ? { ...prev.van } : null;
    try {
        const parsed = parseLendingPage(await httpGetText(LENDING_URL), today);
        // a schedule that was there and is now "nothing at all" (not even "coming soon") smells like a page redesign: keep what we had
        const vanished = parsed.status === 'none' && van && van.stops && van.stops.some(s => s.date >= today);
        if (vanished) { console.warn('   ⚠️ lending: the schedule table disappeared from the page; keeping the last good list'); van.stale = true; }
        else {
            van = {
                name: 'Skate Lending Library', by: 'City of Toronto, with Desjardins', url: LENDING_URL,
                lends: 'skates, helmets and skating aids', terms: 'Free for all ages. No reservation: find the van at the rink.',
                status: parsed.status, startsOn: parsed.startsOn, modified: parsed.modified,
                stops: parsed.stops.map(x => ({ ...x, rink: lendingRinkKey(x, rinks) }))
            };
        }
        if (parsed.skipped.length) console.warn(`   ⚠️ lending: ${parsed.skipped.length} row(s) could not be read: ${parsed.skipped.slice(0, 3).join(' || ')}`);
        console.log(`   ⛸ lending: ${van.status}, ${van.stops.length} stop(s)${van.startsOn ? `, van starts ${van.startsOn}` : ''}`);
    } catch (e) {
        console.warn(`   ⚠️ lending: ${e.message}${prev ? ' (keeping the last good file)' : ''}`);
        if (!van) return prev;
        van.stale = true;
    }
    const out = { generatedAt: new Date().toISOString(), checkedAt: van.stale && prev ? prev.checkedAt : new Date().toISOString(), van, also };
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
    return out;
}


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
                    const res = await readSource(key, cfg, {}, torontoDateStr(), { salvage: () => [] });
                    const rows = res.records;
                    console.log(`   state: ${res.state}${res.error ? ` (${res.error})` : ''}${res.quote ? ` · page says: "${res.quote}"` : ''}${res.note ? ` · ${res.note}` : ''}${res.season ? ` · season ${res.season.from || '?'} to ${res.season.to || '?'}` : ''}${res.opens ? ` · opens ${res.opens}` : ''}`);
                    (res.venues || []).forEach(v => console.log(`     · ${v.name}: ${v.status}${v.reason ? ` (${v.reason})` : ''}`));
                    rows.slice(0, 10).forEach(r => console.log(`     ${r['Start Date']} ${r['Day of Week'].slice(0, 3)} ${r['Start Time']}–${r['End Time']}  ${r.Activity}  @ ${r.LocationName}` +
                        `${r.Paid ? `  $${r.Price}` : '  free'}${r['Age Min'] != null || r['Age Max'] != null ? `  ages ${r['Age Min'] ?? ''}–${r['Age Max'] ?? ''}` : ''}`));
                    if (rows.length > 10) console.log(`     … ${rows.length - 10} more`);
                } catch (e) {
                    console.warn(`   ⚠️ ${key} failed: ${e.message}`);
                }
            }
            return;
        }
        if (process.argv.includes('--reader-selftest')) {
            // one made-up alert through every configured alert-reader tier; writes nothing
            if (!(await readerSelfTest())) process.exitCode = 1;
            return;
        }
        if (process.argv.includes('--lending-only')) {
            // just the free-skates file (the City's lending van schedule + the other confirmed options)
            const out = await fetchLending({ force: true });
            if (out) out.van.stops.slice(0, 12).forEach(x => console.log(`     ${x.date} ${x.from}-${x.to}  ${x.place}${x.rink ? ` [rink ${x.rink}]` : ' [no rink of ours]'}`));
            return;
        }
        if (process.argv.includes('--natural-only')) {
            // just the natural ice list (the City's approved parks for the winter)
            const out = await fetchNaturalIce({ force: true });
            if (out) out.parks.slice(0, 8).forEach(x => console.log(`     ${x.id.padStart(5)}  ${x.name}, ${x.address}${x.lat != null ? `  (${x.lat.toFixed(4)}, ${x.lng.toFixed(4)})` : '  (not placed)'}`));
            return;
        }
        if (process.argv.includes('--facts-only')) {
            let prevRinks = [];
            try { prevRinks = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'rinks.json'), 'utf8')).rinks || []; } catch {}
            prevRinks.forEach(r => { if (!r.website && ARENA_SITES[String(r.locationid)]) r.website = ARENA_SITES[String(r.locationid)]; });
            const only = (process.env.FACTS_ONLY || '').split(',').filter(Boolean);
            await fetchVenueFacts(only.length ? prevRinks.filter(r => only.includes(String(r.locationid))) : prevRinks, { all: true });
            return;
        }
        if (ALERTS_ONLY) {
            await settleNetwork('the light pass');
            let prevPrograms = [];
            try { prevPrograms = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'skating-programs.json'), 'utf8')).programs || []; } catch {}
            await fetchAlerts(prevPrograms);
            try {
                await fetchLiveCheck(prevPrograms);
            } catch (e) {
                console.warn(`   ⚠️ live check skipped: ${e.message}`);
            }
            await refreshLiveSpots();   // PickupHub counts (fail-soft per venue)
            console.log('\n✨ Light pass (alerts + live check + live counts) complete.');
            return;
        }

        // Step 1: Get package info to find resource IDs
        await settleNetwork('the City\'s open data');
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
            if (location['Street Name'] && location['Street Name'] !== 'None') address += location['Street Name'] + ' ';
            if (location['Street Type'] && location['Street Type'] !== 'None') address += location['Street Type'] + ' ';
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
        const merged = enrichedPrograms.concat(externalPrograms);
        const allPrograms = dedupePrograms(merged);
        const duplicatesRemoved = merged.length - allPrograms.length;

        // Step 3c: Rink inventory (indoor + outdoor pads, coordinates)
        console.log('\n🏟️ Building rink inventory...');
        let rinks = [];
        let rinksOk = true;
        try {
            rinks = await fetchRinkInventory(allPrograms, external);
            rinks.forEach(r => { if (!r.website && ARENA_SITES[String(r.locationid)]) r.website = ARENA_SITES[String(r.locationid)]; });
            console.log(`   ✅ ${rinks.length} rink locations`);
        } catch (e) {
            rinksOk = false;
            console.warn(`   ⚠️ rink inventory failed: ${e.message} — keeping previous rinks.json`);
        }

        // Step 3d: Service alerts snapshot
        let alertsInfo = { changed: false, count: 0 };
        try {
            await settleNetwork('the City\'s notices');
            alertsInfo = await fetchAlerts(allPrograms, rinksOk ? rinks : null, external);
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
                duplicatesRemoved,
                cityPrograms: enrichedPrograms.length,
                locations: datasets.locations?.length || 0,
                rinks: rinks.length,
                alerts: alertsInfo.count
            },
            // v3.12: when the City last refreshed its own drop-in file (the status page shows it)
            city: { modified: ckanStamp(resourceMap.dropin && (resourceMap.dropin.last_modified || resourceMap.dropin.metadata_modified)) },
            sources: Object.fromEntries(Object.entries(external).map(([k, v]) => [k, sourceMeta(v)]))
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

        // Home server only: one .ics per upcoming session for Apple's Calendar
        if (process.env.ICS_DIR) {
            try { writeIcsFiles(allPrograms, process.env.ICS_DIR); }
            catch (e) { console.warn(`   ⚠️ .ics export failed: ${e.message}`); }
        }

        // Step 5: cross-check the fresh city rows against toronto.ca's live
        // per-location schedules (the export lags the live system by days)
        try {
            await settleNetwork('the live schedule check');
            await fetchLiveCheck(allPrograms);
        } catch (e) {
            console.warn(`   ⚠️ live check failed: ${e.message} — keeping previous live-check.json`);
        }

        // Step 5b: live counts noted while reading PickupHub (the light pass refreshes them)
        writeLiveSpots();

        // Step 6: venue facts (rentals, admission, helmets) for a few due venues per run
        try {
            await fetchVenueFacts(rinks);
        } catch (e) {
            console.warn(`   ⚠️ venue facts failed: ${e.message} — keeping previous ${FACTS_FILE}`);
        }

        // Step 7: free skates (the City's lending van schedule + other confirmed free options)
        await fetchLending({ rinks });

        // Step 8: natural ice (the parks the City approved for volunteer-built rinks this winter)
        await fetchNaturalIce();

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
module.exports = { parseLendingPage, parseLendingTime, parseLendingDate, lendingRinkKey, fetchLending, LENDING_ALSO, LENDING_URL, llmParseSchedule, parseScheduleText, fetchLiveCheck, EXTERNAL_SOURCES, parseTimeRange, parseSeasonRange, parseDateList, parseWeekdayGridText, parseWeekdayLinesText, favouriteId, writeIcsFiles, dedupePrograms, sessionIdentity, titleCaseIfShouty,
    // alert reader + rink kinds (skate/tests/unit)
    // v3.12: seasons, source states, venue pages, the City's doubles (skate/tests/unit/sources.spec.js)
    parseNaturalIcePage, winterOf, fetchNaturalIce, fetchVenue, stripHtml,
    fetchExternalSources, networkUp, waitForNetwork, settleNetwork, errorText, neverAnswered, sourceSite, keptResult, fetchManual, sitemapLastmod,
    calendarPictures, checkCalendarReading, fetchCalendarImage,
    toRanges, dateRangeIn, datesIn, agesFromLabel, parseDayGridText, parseAuroraPage, fetchAurora, listedDates, parseWhitbyPage, parseUoftPage,
    seasonPhase, readSource, sourceMeta, venueRecords, manualRecords, runReader, foldTwinRinks, markSuperseded, sentenceFrom, rinkSeasonal, RINK_AKA, RINK_TWINS,
    verifyReading, readAlerts, fetchAlerts, readerKey, readerWants, readerUserMessage, readerCreds, readerTiers, readerErrorKind, readerScrub, READER_SCHEMA, READER_VERSION, inferKinds, inOutdoorLull };

