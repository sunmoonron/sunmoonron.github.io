# Peel/Halton drop-in skating data sources — research (verified 2026-09-14)

Scope: Mississauga, Brampton, Oakville, Burlington. Every endpoint below was executed from
Node/curl on 2026-09-14 and returned the described data. Nothing here was taken on trust from
docs or search snippets alone. Raw captures live next to this file (`oak_28_daterange.json`,
`bur_28_daterange.json`, `bram_28_daterange.json`, `miss_skate_events.json`,
`miss_all_skate.json`, `miss_centers.json`, `miss_fees.txt`, `bram_sd.json`, …).

## TL;DR

| City | Platform | Feasibility | Verified 28-day yield (2026-09-14 → 10-11) | Venues w/ coords | Public-skate price (adult / child) | Machine-readable alerts |
|---|---|---|---|---|---|---|
| Mississauga | ActiveNet (`activemississauga`) | **API** (JSON, CI-only: no CORS) | 1,560 Skating & Hockey events for whole season (Sep 14 → Dec 27), 10 rink centres; ~650 are public-skate type | 10/10 (from API) | $4.61 / $3.69 + 13% HST (=$5.21 / $4.17); "At Play" youth skate free | Site-wide alerts JSON (CORS *), news JSON search; ActiveNet `exception_dates` |
| Brampton | PerfectMind org 23782 | **API** (JSON, CI-only) | 525 sessions, 7 venues (191 are Public Skate) | 7/7 (from API) | $2.96 / $2.15 (+HST), 55+ $2.39, 65+ resident free | SharePoint list JSON (city-wide "Service Disruptions", currently parking-only) |
| Oakville | PerfectMind org 24974 | **API** (JSON, CI-only) | 123 sessions, 6 venues (53 recreational skates) | 6/6 from API + Joshua's Creek via Nominatim | $5.38 / $4.31 (+tax); under-2 free | HTML only (service-disruptions archive pages) |
| Burlington | PerfectMind org 22818 | **API** (JSON, CI-only) | 201 sessions, 6 venues (84 Public/19+/Sensory skates) | 6/6 from API + Nelson via Nominatim | $3.50 flat (adult/60+/youth) | HTML only (News module "Closures" category) |

Key gotcha discovered for **all three PerfectMind towns**: the existing `fetchPerfectMind`
(single `page: 0` POST) silently loses data here. `ClassesV2` windows by `page` in 14-day
steps *and* truncates each window after ~50 classes (whole days), so page 0 for Brampton is
5 days and page 1 jumps 14 days ahead. `dateString` is ignored. The fix is the widget's
**Date Range filter** (`values[0][valueKind]=6`), which gives gap-free, untruncated windows —
verified identical counts with 7/3/1-day windows (details in §5).

---

## 0. Conventions recap (from `fetch-skate-data.js`)

* Records are produced by `externalRecord(cfg, sourceKey, {activity, date, startTime, endTime, price, externalId, venue, ageMin, ageMax})` — city-schema fields (`Course Title`, `LocationName`, `Start Time` `HH:MM`, `Start Date` `YYYY-MM-DD`, …) plus `Source`, `ExternalId`, `ExtLocationKey`, `Paid`, `Price`, `RegistrationUrl`, `InfoUrl`, `Unverified`, `Lat/Lng`.
* Multi-venue sources pass `venue: { name, address, district, postalCode, lat, lng, extKey: venueKey(sourceKey, name) }`; `fetchRinkInventory()` emits one rink entry per key in `cfg.venues`.
* `httpPostJSON()` already sends form-encoded bodies with `X-Requested-With: XMLHttpRequest` — exactly what PerfectMind needs; `fetchJSON()` is GET-only, so the ActiveNet JSON POSTs need a small `httpPostJSONBody()` helper (JSON body + `page_info` header).
* Times from every feed below are **facility-local (America/Toronto), naive** — same as DaySmart/PerfectMind today.

---

## 1. City of Mississauga — ActiveNet

### 1.1 Platform
ActiveNet, org `activemississauga`: `https://anc.ca.apm.activecommunities.com/activemississauga/`.
The city page links "Find drop in programs" → `activity/search?activity_select_param=2&activity_keyword=…` (2 = Drop-In) and a per-location calendar (`calendars?defaultCalendarId=1&locationId=56`). Calendar id **1 = "Drop In Programs"** (GET `/rest/onlinecalendar/calendars` → ids 1 Drop In Programs, 2 Library Programs, 3 Drop In Pickleball).

### 1.2 Feasibility: **API**. Four public REST endpoints, no auth, no cookies. **No `Access-Control-Allow-Origin` header** → CI snapshot only (like toronto.ca).

### 1.3 Working requests

**(A) Per-date sessions for all rink centres, one request (the one to build on)**

```
POST https://anc.ca.apm.activecommunities.com/activemississauga/rest/onlinecalendar/multicenter/events?locale=en-US
Content-Type: application/json;charset=UTF-8
Accept: application/json

{"calendar_id":1,
 "center_ids":[290,248,240,250,252,253,100,82,128,106],
 "display_all":0,
 "search_start_time":"2026-09-14","search_end_time":"2026-10-12",
 "facility_ids":[],
 "activity_category_ids":[52],
 "activity_sub_category_ids":[],"activity_ids":[],
 "activity_min_age":null,"activity_max_age":null,"event_type_ids":[]}
```
→ 200, 2.4 MB, `body.center_events[]` (one per centre) each with `events[]`. **Date bounds are ignored** (also tried `start_date/end_date` and timestamps): the response always spans the whole calendar period (2026-09-14 → 2026-12-27, per `filters.calendar_period`), so filter by date client-side. Category **52 = "Skating & Hockey"** is honoured (1,560 events vs. 1,809 for one centre unfiltered). Per-centre requests work too if you want smaller payloads.

Event titles returned (whole season): `Fun Skate` 332, `Drop In Adult & Older Adult Skate` 259, `At Play- Fun Skate` 90, `Drop In Adult Skate Fit` 42, `Drop In Figure Skating` 83, plus shinny / stick & puck variants (`Drop In Hockey Shinny (18+)` 203, `Drop In 55+ Hockey Shinny` 110, `Drop In Hockey Stick & Puck With Adult (9-13 yrs)` 134, …).

**(B) Centre / category / facility ids** (how the ids above were obtained)
```
POST …/rest/onlinecalendar/filters?locale=en-US     body: {"calendar_id":1}
```
→ `body.center[]` (21 centres), `body.activity_category[]` (`{"id":52,"name":"Skating & Hockey","centerIds":[240,128,82,290,100,248,250,106,252,253]}`), `body.facilities[]` (rink pads, e.g. `619 Iceland Arena Rink 1`), `body.calendar_period`.

**(C) Drop-in activity list with ages** (weekly-pattern series, 20/page — the server ignores larger `total_records_per_page`)
```
POST …/rest/activities/list?locale=en-US
Content-Type: application/json;charset=UTF-8
page_info: {"order_by":"","page_number":1,"total_records_per_page":20}

{"activity_search_pattern":{"skills":[],"time_after_str":"","days_of_week":null,
  "activity_select_param":2,"center_ids":[],"time_before_str":"","open_spots":null,
  "activity_id":null,"activity_category_ids":[],"date_before":"","min_age":null,"date_after":"",
  "activity_type_ids":[],"site_ids":[],"for_map":false,"geographic_area_ids":[],"season_ids":[],
  "activity_department_ids":[],"activity_other_category_ids":[],"child_season_ids":[],
  "activity_keyword":"skate","instructor_ids":[],"max_age":null,"custom_price_from":"","custom_price_to":""},
 "activity_transfer_pattern":{}}
```
→ `headers.page_info.total_records` 61 (4 pages) ; `body.activity_items[]` with `id`, `number`, `name`, `ages`, `age_min_year`, `age_max_year`, `location.label`, `days_of_week`, `time_range`, `date_range_start/end`, `total_open`, `allow_drop_in_reg` (false — no per-session online booking; "tickets sold 30 min prior").

**(D) Activity detail (venue address + lat/lng, activity_type)**
```
GET …/rest/activity/detail/147338?locale=en-US
```
→ `body.detail.centers[0]` = `{"name":"Burnhamthorpe Community Centre","address1":"1500 Gulleden Drive","zip_code":"L4X 2T7","latitude":43.6227,"longitude":-79.5988,…}`, `activity_type:"Drop In Program"`, `category:"Skating & Hockey"`, `facilities[]`.

**(E) Meeting dates incl. cancellations**
```
GET …/rest/activity/detail/meetingandregistrationdates/147588?locale=en-US     (id is a PATH segment; ?activity_id= form returns "No result found")
```
→ `activity_patterns[{beginning_date, ending_date, exception_dates[], pattern_dates[{weekdays:"Tue", starting_time:"16:00:00", ending_time:"16:50:00"}]}]`, `additional_dates[]`. `exception_dates` is where a cancelled/holiday date shows up.

### 1.4 Trimmed sample (from A, joined with C for ages)
```json
[
 {"center_name":"Burnhamthorpe Community Centre","title":"At Play- Fun Skate",
  "start_time":"2026-10-07 15:45:00","end_time":"2026-10-07 17:00:00",
  "event_item_id":154647,"facility":"Burnhamthorpe CC Rink - Chic Murray","price":{"free":true},
  "activity_detail_url":"https://ca.apm.activecommunities.com/activemississauga/Activity_Search/at-play--fun-skate/154647"},
 {"center_name":"Clarkson Community Centre","title":"At Play- Fun Skate",
  "start_time":"2026-09-29 16:00:00","end_time":"2026-09-29 16:50:00",
  "event_item_id":147588,"facility":"Clarkson CC Rink","price":{"free":true}},
 {"center_name":"Burnhamthorpe Community Centre","title":"Fun Skate",
  "start_time":"2026-09-26 14:15:00","end_time":"2026-09-26 15:45:00",
  "event_item_id":147338,"facility":"Burnhamthorpe CC Rink - Chic Murray","price":{"free":false}}
]
// list endpoint (C) record giving ages for a Fun Skate series:
{"id":147317,"number":"149330","name":"Fun Skate","ages":"3 and up","age_min_year":3,"age_max_year":0,
 "location":"Iceland Arena","days_of_week":"Sun","time_range":"1:45 PM - 3:15 PM",
 "date_range_start":"2026-09-27","date_range_end":"2026-12-27","total_open":160}
```
Ages by program (from C): `At Play- Fun Skate` 10–17 (free), `Fun Skate` 3+, `Drop In Adult & Older Adult Skate` 18+, `Drop In Adult Skate Fit` 18+ (advanced skaters).
Price is **not** in the API (`price.show_price_info_online:false`, only a `free` flag) → use the by-law rates below as `defaultPrice` per program.

### 1.5 Venues (all from the API; `center_id` is the join key)
| Venue (center_id) | Address | Postal | Lat, Lng | skate/total events (season) |
|---|---|---|---|---|
| Burnhamthorpe Community Centre (290) | 1500 Gulleden Drive | L4X 2T7 | 43.6227, -79.5988 | 104/176 |
| Carmen Corbasson Community Centre (248) | 1399 Cawthra Road | L5G 4L1 | 43.5782, -79.5767 | 61/134 |
| Clarkson Community Centre (240) | 2475 Truscott Drive | L5J 2B3 | 43.5116, -79.6503 | 72/121 |
| Erin Mills Twin Arena (250) | 3205 Unity Drive | L5L 4L5 | 43.5371, -79.7116 | 79/138 |
| Huron Park Recreation Centre (252) | 830 Paisley Blvd W | L5C 3P5 | 43.5591, -79.6331 | 47/71 |
| Iceland Arena (253) | 705 Matheson Blvd E | L4Z 3X9 | 43.628, -79.6494 | 81/342 |
| Meadowvale 4 Rinks (100) | 2160 Torquay Mews | L5N 2M6 | 43.5952, -79.7409 | 117/323 |
| Mississauga Valley Community Centre (82) | 1275 Mississauga Valley Blvd | L5A 3R8 | 43.597, -79.6239 | 102/183 |
| Paul Coffey Arena (128) | 6990 Goreway Drive | L4T 1A9 | 43.7125, -79.6311 | 24/24 |
| Port Credit Memorial Arena (106) | 40 Stavebank Road | L5G 2T8 | 43.553, -79.589 | 36/48 |

Not in the Skating & Hockey calendar this season (no drop-ins): Tomken Twin Arena, Mississauga Sports & Entertainment Centre (ex-Paramount).

### 1.6 Prices — By-law 0165-2025 Schedule E-3 (2026 season, "Spring 2026 → Winter 2027"), amounts **exclude 13% HST**
* Fun Swim/Skate per visit: **Adult $4.61** (→ $5.21), **Child/Youth, Older Adult (55–64), Disability, Student $3.69** (→ $4.17), Group $16.03; 5+-visit tickets $4.15 / $3.32; **preschoolers 3 and under free**; 65+ Mississauga residents free ("65+ Fit" membership).
* Skate Fit: Adult $17.22, OA/Youth $13.74. Shinny/Figure-skating patch: Adult $6.96, OA/Youth $5.56, Youth 13–17 (50 min) $3.71. Stick & Puck: Adult $5.96 (90 min) / $3.98 (50 min), OA/Youth $4.77 / $3.18.
* `At Play- Fun Skate` (10–17) is free (API `price.free:true`, description says FREE).
* 2025 rates for reference: adult $4.48, child $3.58.
Source PDF: `https://www.mississauga.ca/wp-content/uploads/2026/03/03152552/Schedule-E-3-Recreation-and-Culture-Program-Fees-and-Charges.pdf` (text extracted with pdftotext → `miss_fees.txt`).

### 1.7 Alerts
* `GET https://www.mississauga.ca/wp-json/com/v1/lists/site_wide_alerts` → `{"success":true,"alerts":[]}` (200, **CORS `*`**, currently empty). Site-wide banner, not arena-specific.
* `GET https://www.mississauga.ca/wp-json/wp/v2/news?search=facility%20closures&per_page=5&_fields=id,date,title,link` → JSON news posts (CORS `*`). The city posts "City program cancellations and facility closures – <date>" news items during storms; keyword-filter these.
* Per-session cancellations: ActiveNet `meetingandregistrationdates/{id}` → `exception_dates[]` (and the calendar feed is generated from the same patterns, so a cancelled date should simply vanish on the next snapshot).
* No arena-specific alert feed exists (arena pages such as `/recreation-and-sports/locations/iceland-arena/` carry no notice block today).

### 1.8 Suggested `EXTERNAL_SOURCES` entry (new kind `activenet`)
```js
'mississauga': {
    kind: 'activenet',
    // City of Mississauga drop-ins — ActiveNet online calendar (calendar 1 =
    // "Drop In Programs", category 52 = "Skating & Hockey"). One POST returns
    // every dated session for the whole season across the listed centres;
    // no date filter is honoured server-side, we window client-side.
    base: 'https://anc.ca.apm.activecommunities.com/activemississauga/rest',
    calendarId: 1,
    categoryIds: [52],
    centerIds: [290, 248, 240, 250, 252, 253, 100, 82, 128, 106],
    daysAhead: 28,
    paid: true,
    // Prices aren't in the API (only a free flag) → 2026 by-law rates incl. HST.
    programs: [
        { match: /^At Play- Fun Skate$/i, activity: 'Fun Skate (Youth 10-17, Free)', defaultPrice: 0, ageMin: 10, ageMax: 17 },
        { match: /^Fun Skate$/i, activity: 'Fun Skate', defaultPrice: 5.21, ageMin: 3 },
        { match: /Adult & Older Adult Skate/i, activity: 'Adult & Older Adult Skate', defaultPrice: 5.21, ageMin: 18 },
        { match: /Adult Skate Fit/i, activity: 'Adult Skate Fit', defaultPrice: 19.46, ageMin: 18 }
    ],
    venues: {
        'Burnhamthorpe Community Centre': { address: '1500 Gulleden Dr', postalCode: 'L4X 2T7', lat: 43.6227, lng: -79.5988 },
        'Carmen Corbasson Community Centre': { address: '1399 Cawthra Rd', postalCode: 'L5G 4L1', lat: 43.5782, lng: -79.5767 },
        'Clarkson Community Centre': { address: '2475 Truscott Dr', postalCode: 'L5J 2B3', lat: 43.5116, lng: -79.6503 },
        'Erin Mills Twin Arena': { address: '3205 Unity Dr', postalCode: 'L5L 4L5', lat: 43.5371, lng: -79.7116 },
        'Huron Park Recreation Centre': { address: '830 Paisley Blvd W', postalCode: 'L5C 3P5', lat: 43.5591, lng: -79.6331 },
        'Iceland Arena': { address: '705 Matheson Blvd E', postalCode: 'L4Z 3X9', lat: 43.628, lng: -79.6494 },
        'Meadowvale 4 Rinks': { address: '2160 Torquay Mews', postalCode: 'L5N 2M6', lat: 43.5952, lng: -79.7409 },
        'Mississauga Valley Community Centre': { address: '1275 Mississauga Valley Blvd', postalCode: 'L5A 3R8', lat: 43.597, lng: -79.6239 },
        'Paul Coffey Arena': { address: '6990 Goreway Dr', postalCode: 'L4T 1A9', lat: 43.7125, lng: -79.6311 },
        'Port Credit Memorial Arena': { address: '40 Stavebank Rd', postalCode: 'L5G 2T8', lat: 43.553, lng: -79.589 }
    },
    defaultDistrict: 'Mississauga',
    // No per-session online booking (tickets sold 30 min before); deep-link the activity page.
    registrationUrl: (date, ev) => `https://anc.ca.apm.activecommunities.com/activemississauga/activity/search/detail/${ev.event_item_id}?onlineSiteId=0&from_original_cui=true&locale=en-US`,
    infoUrl: 'https://www.mississauga.ca/recreation-and-sports/sports-and-activities/skating-and-hockey/'
}
```
Fetcher sketch (`fetchActiveNet`): POST (A) → for each `center_events[].events[]` whose `title` matches a `programs` rule and whose `start_time` date ∈ [today, today+daysAhead] → `externalRecord(cfg, key, { activity, date: start_time.slice(0,10), startTime: start_time.slice(11,16), endTime: end_time.slice(11,16), price: rule.defaultPrice, externalId: `${event_item_id}-${date}`, ageMin/ageMax from rule (or from (C) joined on `id === event_item_id`), venue: { name: center_name, ...cfg.venues[center_name], extKey: venueKey(key, center_name) } })`. Note `registrationUrl` would need the event passed through (today's signature is `registrationUrl(date)`), or set `RegistrationUrl` from `activity_detail_url` inside the fetcher.

---

## 2. City of Brampton — PerfectMind

### 2.1 Platform
PerfectMind, org **23782**: `https://cityofbrampton.perfectmind.com/23782/Clients/…`. brampton.ca only links the sign-in page; the public drop-in widget is
`https://cityofbrampton.perfectmind.com/23782/Clients/BookMe4?widgetId=15f6af07-39c5-473e-b053-96653f77a406` ("All Registered Programs & Drop-In"). Its categories (POST `/23782/Clients/BookMe4V2/GetCategoriesDataV2?embed=False`, form `widgetId=…`) include **"Drop-In and Try-It Programs" → "Skating"**, calendarId **`66a6c983-2ead-42a9-8445-d926fa974fbf`** (BookingType 2 = drop-in). Booking page: `https://cityofbrampton.perfectmind.com/23782/Clients/BookMe4BookingPages/Classes?calendarId=66a6c983-2ead-42a9-8445-d926fa974fbf&widgetId=15f6af07-39c5-473e-b053-96653f77a406&embed=False`.

### 2.2 Feasibility: **API** (same JSON the booking page loads; CORS header = own origin only → CI).

### 2.3 Working request (28 days, 1-day windows because Brampton has up to 32 sessions/day and the server truncates windows at ≥50 — see §5)
```
POST https://cityofbrampton.perfectmind.com/23782/Clients/BookMe4BookingPagesV2/ClassesV2
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest

calendarId=66a6c983-2ead-42a9-8445-d926fa974fbf&widgetId=15f6af07-39c5-473e-b053-96653f77a406&page=0
&values[0][value]=2026-09-14&values[0][value2]=2026-09-15&values[0][valueKind]=6
```
(URL-encode the brackets: `values%5B0%5D%5Bvalue%5D=…`). Response `{classes:[…], classesMaxEndDateString, nextKey}`; with a 1–2-day window `nextKey` == window end. Looping 2026-09-14 → 10-11 gave **525 sessions / 7 venues, every day covered**; 1-day and 2-day runs matched exactly.

### 2.4 Trimmed sample
```json
[
 {"EventName":"Public Skate Drop-In (All Ages) | Susan Fennell 12:00-12:50pm",
  "Location":"Susan Fennell Sportsplex (South Fletcher's)","OccurrenceDate":"20260914",
  "EventTimeDescription":"12:00 pm - 12:50 pm","PriceRange":"$0.00 - $2.96",
  "MinAge":null,"MaxAge":null,"NoAgeRestriction":true,"Spots":"","BookButtonText":"CLOSED",
  "EventId":"1ae95447-b718-5d42-0336-3aab8d2812cd","CourseIdTrimmed":"543470","Facility":"SF Arena Ice (3) 0:00",
  "Address":{"Street":"500 Ray Lawson Blvd","PostalCode":"L6Y 5B3","Latitude":43.652793,"Longitude":-79.735956}},
 {"EventName":"Public Skate Drop-In (55+ Years) | Cassie Campbell 10:15-11:05am",
  "Location":"Cassie Campbell Community Centre","OccurrenceDate":"20260915",
  "EventTimeDescription":"10:15 am - 11:05 am","PriceRange":"$0.00 - $2.39",
  "MinAge":55,"MaxAge":null,"Spots":"50 spots left","BookButtonText":"Register Now!",
  "EventId":"b66b4671-11a3-443d-a4d2-9c191f470b9d",
  "Address":{"Street":"1050 Sandalwood Pkwy W","PostalCode":"L7A 0K9","Latitude":43.696632,"Longitude":-79.824842}},
 {"EventName":"Public Skate Drop-In (All Ages) | Earnscliffe 9:00-9:50am",
  "Location":"Earnscliffe Recreation Centre","OccurrenceDate":"20260916",
  "EventTimeDescription":"09:00 am - 09:50 am","PriceRange":"$0.00 - $2.96","NoAgeRestriction":true,
  "Address":{"Street":"44 Eastbourne Dr","PostalCode":"L6T 2B2","Latitude":43.723334,"Longitude":-79.699493}}
]
```
Event-name families on the calendar: `Public Skate Drop-In (All Ages | 18+ Years | 55+ Years)`, `Figure Skating Drop-In (6+ Years)`, `Shinny Drop-In …`, `Hockey Shoot Around …`. Brampton appends ` | <venue short name> <time>` to `EventName` — strip everything from ` | `.

### 2.5 Venues (all from the feed's `Address`; skate/total sessions in the 28-day window)
| Venue | Address | Postal | Lat, Lng | Public-skate / all |
|---|---|---|---|---|
| Cassie Campbell Community Centre | 1050 Sandalwood Pkwy W | L7A 0K9 | 43.696632, -79.824842 | 27/82 |
| Century Gardens Recreation Centre | 340 Vodden St E | L6V 2N2 | 43.708429, -79.753575 | 8/70 |
| Earnscliffe Recreation Centre | 44 Eastbourne Dr | L6T 2B2 | 43.723334, -79.699493 | 50/99 |
| Greenbriar Recreation Centre | 1100 Central Park Dr | L6S 2C9 | 43.735986, -79.717288 | 11/43 |
| Jim Archdekin Recreation Centre | 292 Conestoga Dr | L6Z 3M1 | 43.71733, -79.789659 | 21/57 |
| Susan Fennell Sportsplex (South Fletcher's) | 500 Ray Lawson Blvd | L6Y 5B3 | 43.652793, -79.735956 | 65/131 |
| Terry Miller Recreation Centre | 1295 Williams Pkwy | L6S 3J8 | 43.73265, -79.730347 | 14/43 |

Other Brampton arenas exist in the widget's Location filter (e.g. "Brampton Memorial Arena" `f4b1126b-1e7b-43a4-a628-cc54988ae6d8`) but have no drop-in skating sessions in the window; Victoria Park Arena and Chris Gibson RC are under revitalization.

### 2.6 Prices
* Class landing page fee tiers (`/23782/Clients/BookMe4LandingPages/Class?widgetId=…&classId=<EventId>&occurrenceDate=<yyyymmdd>`), "[2026/27] Drop-In … Plus Tax": **Adult $2.96, Child/Youth/Teen $2.15, A55 $2.39**, A65 resident member free, Swim/Skate / Fitness / Youth / Neighbourhood members free. `PriceRange` max therefore = adult pre-tax rate ($2.96 public skate, $2.39 for 55+ sessions, $6.58 figure skating, $9.54 prime-time shinny 18+, $5.43 non-prime, $2.15 youth shinny).
* brampton.ca Memberships page per-visit table (Swim & Skate): Family $8.42, Child/Youth/Teen $2.05, Adult $2.82, Adult 55+ $2.28, 70+ Free (older year; "all rates subject to HST", 50% non-resident surcharge on memberships).
* Registration opens 25 h ahead for residents/members, 1 h for non-residents.

### 2.7 Alerts
* **SharePoint REST, verified JSON**:
  ```
  GET https://www.brampton.ca/EN/City-Hall/Accessibility/_api/web/lists/getbytitle('Service%20Disruptions')/items?$select=Id,Title,Reason,Start_x0020_Date,Expected_x0020_End_x0020_Date,Expected_x0020_Duration,Additional_x0020_Information,PublishingContactEmail,Modified&$orderby=Modified%20desc&$top=100
  Accept: application/json;odata=nometadata
  ```
  → `{"value":[{"Id":7,"Title":"West Tower Parking Garage Temporary Closure","Reason":"Construction","Start_x0020_Date":"2026-06-06T04:00:00Z","Expected_x0020_Duration":"7am-7pm","Additional_x0020_Information":"…"}, …]}` — 3 items today, all parking; it is the city-wide AODA disruption list, arena closures are not guaranteed to appear. Response carried `Access-Control-Allow-Origin: *`.
* Recreation "Holiday Hours" page (HTML): `/EN/residents/Recreation/Pages/Holiday-Hours.aspx`.
* In the PerfectMind feed, a cancelled occurrence is expected to disappear (or flip `BookButtonText` to `CLOSED`); observed states: `Register Now!`, `More Info`, `CLOSED`; `Spots: "N spots left"`.

### 2.8 Suggested entry
```js
'brampton': {
    kind: 'perfectmind',
    base: 'https://cityofbrampton.perfectmind.com/23782',   // org path is part of base
    widgetId: '15f6af07-39c5-473e-b053-96653f77a406',
    calendarId: '66a6c983-2ead-42a9-8445-d926fa974fbf',    // Drop-In → Skating
    daysAhead: 28,
    windowDays: 1,            // busiest calendar: ≤32 sessions/day, server truncates ≥50/window
    include: /public skate/i, // keep public skates; drop shinny / shoot-around / figure skating
    cleanName: (n) => n.replace(/\s*\|.*$/, ''),   // "Public Skate Drop-In (All Ages) | Susan Fennell 12:00-12:50pm"
    paid: true,
    venues: {  // feed also carries Address/lat/lng; keep this as override + rink-inventory source
        'Cassie Campbell Community Centre': { address: '1050 Sandalwood Pkwy W', district: 'Brampton', postalCode: 'L7A 0K9', lat: 43.696632, lng: -79.824842 },
        'Century Gardens Recreation Centre': { address: '340 Vodden St E', district: 'Brampton', postalCode: 'L6V 2N2', lat: 43.708429, lng: -79.753575 },
        'Earnscliffe Recreation Centre': { address: '44 Eastbourne Dr', district: 'Brampton', postalCode: 'L6T 2B2', lat: 43.723334, lng: -79.699493 },
        'Greenbriar Recreation Centre': { address: '1100 Central Park Dr', district: 'Brampton', postalCode: 'L6S 2C9', lat: 43.735986, lng: -79.717288 },
        'Jim Archdekin Recreation Centre': { address: '292 Conestoga Dr', district: 'Brampton', postalCode: 'L6Z 3M1', lat: 43.71733, lng: -79.789659 },
        "Susan Fennell Sportsplex (South Fletcher's)": { address: '500 Ray Lawson Blvd', district: 'Brampton', postalCode: 'L6Y 5B3', lat: 43.652793, lng: -79.735956 },
        'Terry Miller Recreation Centre': { address: '1295 Williams Pkwy', district: 'Brampton', postalCode: 'L6S 3J8', lat: 43.73265, lng: -79.730347 }
    },
    defaultDistrict: 'Brampton',
    registrationUrl: () => 'https://cityofbrampton.perfectmind.com/23782/Clients/BookMe4BookingPages/Classes?calendarId=66a6c983-2ead-42a9-8445-d926fa974fbf&widgetId=15f6af07-39c5-473e-b053-96653f77a406&embed=False',
    infoUrl: 'https://www.brampton.ca/EN/residents/Recreation/Programs-Activities/Pages/Skating.aspx'
}
```

---

## 3. Town of Oakville — PerfectMind

### 3.1 Platform
PerfectMind, org **24974**. oakville.ca links `https://townofoakville.perfectmind.com/24974/Clients/BookMe4?widgetId=e621581b-5db2-4635-a887-4f02b9585807` ("Recreational Skating - Linked Start Page"). `GetCategoriesDataV2` → category "Drop-in Programs" → calendar **"Recreational Skating and Shinny Hockey"** `332fd288-9a60-4b8f-9b7b-373c4e1bed5d` (BookingType 2). Booking page: `…/24974/Clients/BookMe4BookingPages/Classes?calendarId=332fd288-9a60-4b8f-9b7b-373c4e1bed5d&widgetId=e621581b-5db2-4635-a887-4f02b9585807&embed=False`.

### 3.2 Feasibility: **API** (CI-only; `access-control-allow-origin: https://townofoakville.perfectmind.com`).

### 3.3 Working request (7-day windows; max 38 classes/window)
```
POST https://townofoakville.perfectmind.com/24974/Clients/BookMe4BookingPagesV2/ClassesV2
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest

calendarId=332fd288-9a60-4b8f-9b7b-373c4e1bed5d&widgetId=e621581b-5db2-4635-a887-4f02b9585807&page=0
&values[0][value]=2026-09-14&values[0][value2]=2026-09-20&values[0][valueKind]=6
```
Four windows → **123 sessions** (Sep 14 → Oct 11); Sep 25–27 genuinely have no sessions (window 09-21..09-27 returned 23 classes ending 09-24 with `nextKey` 09-27, i.e. not truncated). The whole calendar currently runs to 2026-12-30.

### 3.4 Trimmed sample
```json
[
 {"EventName":"Recreation Skate","Location":"River Oaks Community Centre","OccurrenceDate":"20260914",
  "EventTimeDescription":"12:00 pm - 2:00 pm","PriceRange":"$0.00 - $5.38","MinAge":null,"MaxAge":null,
  "Spots":"","BookButtonText":"Unavailable","Facility":"Arena B","EventId":"98d92e13-7675-1e44-88ee-6ece58c02859","CourseIdTrimmed":"162736",
  "Address":{"Street":"2400 Sixth Line","PostalCode":"L6H 3N8","Latitude":43.47104,"Longitude":-79.72358}},
 {"EventName":"Recreational Skate - Ages 18+","Location":"Trafalgar Park Community Centre-133 Rebecca ","OccurrenceDate":"20260914",
  "EventTimeDescription":"1:00 pm - 3:00 pm","PriceRange":"$0.00 - $5.38","MinAge":18,"MaxAge":null,
  "Spots":"99 spots left","BookButtonText":"Register","Facility":"Arena","EventId":"2816c241-3fc9-205e-c273-effb74b1c0ea",
  "Address":{"Street":"133 Rebecca St.","PostalCode":"L6K 1J4","Latitude":43.439878,"Longitude":-79.677705}},
 {"EventName":"Recreational Skate","Location":"Glen Abbey Community Centre","OccurrenceDate":"20260915",
  "EventTimeDescription":"6:30 pm - 8:00 pm","PriceRange":"$0.00 - $5.38","Spots":"76 spots left","BookButtonText":"Register","Facility":"Arena Green",
  "Address":{"Street":"1415 Third Line","PostalCode":"L6M 3G2","Latitude":43.435554,"Longitude":-79.739041}}
]
```
Name variants for the same product: `Recreation Skate`, `Recreational Skate`, `Recreational Skating`, `Recreational Skating Drop-in`, `Recreational Skate - Ages 18+` (18+), plus `Shinny Hockey …`, `Stick and Puck …` (some `No fee` goalie rows). Ages come as `MinAge/MaxAge` (`MaxAge` null = open-ended; `NoAgeRestriction:false` even when both null, so treat null as "no limit").

### 3.5 Venues (feed `Address` + Nominatim for Joshua's Creek)
| Venue | Address | Postal | Lat, Lng | Rec-skate / all (28 d) |
|---|---|---|---|---|
| Glen Abbey Community Centre | 1415 Third Line | L6M 3G2 | 43.435554, -79.739041 | 12/42 |
| Joshua's Creek Arenas (no drop-in skates in window; Location filter id `478e1bef-b8bd-4eb2-90ec-e3a8591b9be8`) | 1663 North Service Rd E | L6H 7G5 | 43.4917310, -79.6761115 (Nominatim `ice_rink` node) | 0/0 |
| Kinoak Arena | 363 Warminster Dr | L6L 4N1 | 43.4198, -79.699932 | 1/1 |
| Maple Grove Arena | 2237 Devon Rd | L6J 5M1 | 43.479078, -79.643756 | 2/2 |
| River Oaks Community Centre | 2400 Sixth Line | L6H 3N8 | 43.47104, -79.72358 | 14/54 |
| Sixteen Mile Sports Complex | 3070 Neyagawa Blvd | L6M 4L6 | 43.465913, -79.749331 | 3/3 |
| Trafalgar Park Community Centre (feed label `Trafalgar Park Community Centre-133 Rebecca ` — trim) | 133 Rebecca St | L6K 1J4 | 43.439878, -79.677705 | 21/21 |

Outdoor refrigerated pads (Trafalgar Park, Wallace Park 245 Reynolds St) are free, no pre-registration, and not on this calendar (a separate "Trafalgar Park" Location id `e2ac1b81-…` exists in the filter).

### 3.6 Prices (class page "Fees", 2026)
**Adult $5.38; Child / Youth / Older Adult (65+) $4.31; Child under 2 free** — oakville.ca states these are "plus tax", group of 5+ $3.88 pp. Shinny 18+/50+ $8.77 (goalies free), youth/65+ stick & puck $4.31. Skate rental $6.88, helmet $3.48, combo $8.22 (+tax, in person only). Members: $0.00 (that is the `$0.00 -` in `PriceRange`).

### 3.7 Alerts — HTML only
* `https://www.oakville.ca/town-hall/news-notices/2026-service-disruptions-archive/` (dated list of notices: holiday closures, "Proactive program cancellations …", power failures) and `https://www.oakville.ca/town-hall/news-notices/weather-related-service-updates/`. No RSS/JSON link on the pages; the page list is simple `<a>` items under a "2026 Service Disruptions" heading → easy keyword scrape ("arena", "cancel", "closed").
* PerfectMind states: `BookButtonText` `Register` / `More Info` / `Unavailable`; `Spots` `"N spots left"` or `"Full"`.

### 3.8 Suggested entry
```js
'oakville': {
    kind: 'perfectmind',
    base: 'https://townofoakville.perfectmind.com/24974',
    widgetId: 'e621581b-5db2-4635-a887-4f02b9585807',
    calendarId: '332fd288-9a60-4b8f-9b7b-373c4e1bed5d',   // Recreational Skating and Shinny Hockey
    daysAhead: 28,
    windowDays: 7,
    include: /recreation(al)?\s+skat/i,
    paid: true,
    venues: {
        'Glen Abbey Community Centre': { address: '1415 Third Line', district: 'Oakville', postalCode: 'L6M 3G2', lat: 43.435554, lng: -79.739041 },
        "Joshua's Creek Arenas": { address: '1663 North Service Rd E', district: 'Oakville', postalCode: 'L6H 7G5', lat: 43.491731, lng: -79.676112 },
        'Kinoak Arena': { address: '363 Warminster Dr', district: 'Oakville', postalCode: 'L6L 4N1', lat: 43.4198, lng: -79.699932 },
        'Maple Grove Arena': { address: '2237 Devon Rd', district: 'Oakville', postalCode: 'L6J 5M1', lat: 43.479078, lng: -79.643756 },
        'River Oaks Community Centre': { address: '2400 Sixth Line', district: 'Oakville', postalCode: 'L6H 3N8', lat: 43.47104, lng: -79.72358 },
        'Sixteen Mile Sports Complex': { address: '3070 Neyagawa Blvd', district: 'Oakville', postalCode: 'L6M 4L6', lat: 43.465913, lng: -79.749331 },
        'Trafalgar Park Community Centre': { address: '133 Rebecca St', district: 'Oakville', postalCode: 'L6K 1J4', lat: 43.439878, lng: -79.677705 }
    },
    venueAliases: { 'Trafalgar Park Community Centre-133 Rebecca': 'Trafalgar Park Community Centre' },
    defaultDistrict: 'Oakville',
    registrationUrl: () => 'https://townofoakville.perfectmind.com/24974/Clients/BookMe4BookingPages/Classes?calendarId=332fd288-9a60-4b8f-9b7b-373c4e1bed5d&widgetId=e621581b-5db2-4635-a887-4f02b9585807&embed=False',
    infoUrl: 'https://www.oakville.ca/parks-recreation-culture/programs-activities/skating/'
}
```

---

## 4. City of Burlington — PerfectMind

### 4.1 Platform
PerfectMind, org **22818**. burlington.ca links two single-calendar widgets: `…/22818/Reports/BookMe4?widgetId=8d8b4749-9c4e-4762-be93-fe54f1e1203b` ("Recreational Skating Drop In Programs") and `…widgetId=a31d184d-c1db-4d78-8af1-c381f16abd0b` ("Recreational Hockey Drop In"). `GetCategoriesDataV2` for either returns `{"redirectUrl":"/22818/Reports/BookMe4BookingPages/Classes?calendarId=517e0420-1478-458e-8a6f-ad813e278ec0&…&singleCalendarWidget=true"}` — i.e. **both widgets share calendar `517e0420-1478-458e-8a6f-ad813e278ec0`**, which carries skating *and* sticks-and-pucks. `/22818/Reports/…` and `/22818/Clients/…` return identical JSON.

### 4.2 Feasibility: **API** (CI-only).

### 4.3 Working request (3-day windows; ≤27 classes/window)
```
POST https://cityofburlington.perfectmind.com/22818/Clients/BookMe4BookingPagesV2/ClassesV2
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest

calendarId=517e0420-1478-458e-8a6f-ad813e278ec0&widgetId=8d8b4749-9c4e-4762-be93-fe54f1e1203b&page=0
&values[0][value]=2026-09-14&values[0][value2]=2026-09-16&values[0][valueKind]=6
```
→ **201 sessions**, every day Sep 14 → Oct 11 covered; 7-day and 3-day runs produced identical per-date counts. Calendar runs to 2026-12-29.

### 4.4 Trimmed sample
```json
[
 {"EventName":"Public Skate","Location":"Skyway Community Centre","OccurrenceDate":"20260920",
  "EventTimeDescription":"11:00 am - 12:00 pm","PriceRange":"$0.00 - $3.50","MinAge":1,"MaxAge":120,
  "Spots":"166 spots left","BookButtonText":"Register","Facility":"Rink","EventId":"82b36850-b4d3-965f-4599-22f7022604a4","CourseIdTrimmed":"294353",
  "Address":{"Street":"129 Kenwood Avenue","PostalCode":"L7M 1V8","Latitude":43.368761,"Longitude":-79.733246}},
 {"EventName":"Skate 19+","Location":"Central Arena","OccurrenceDate":"20260914",
  "EventTimeDescription":"11:30 am - 01:00 pm","PriceRange":"$0.00 - $3.50","MinAge":19,"MaxAge":120,
  "Spots":"","BookButtonText":"Closed","Facility":"Rink","EventId":"e7d7d226-9497-3540-5e70-d809b6cd543f",
  "Address":{"Street":"519 Drury Lane","PostalCode":"L7R 2H2","Latitude":43.335167,"Longitude":-79.792986}},
 {"EventName":"Skate 19+","Location":"Appleby Ice Centre","OccurrenceDate":"20260914",
  "EventTimeDescription":"11:30 am - 01:00 pm","PriceRange":"$0.00 - $3.50","MinAge":19,"MaxAge":120,"Facility":"Rink 4",
  "Address":{"Street":"1201 Appleby Line","PostalCode":"L7S 1E4","Latitude":43.38674,"Longitude":-79.775557}}
]
```
Event names: `Public Skate` (ages 1–120), `Skate 19+`, `Sensory Skate`, and `Sticks and Pucks …` / `Goalie Sticks and Pucks …` (goalies `No fee`). `MaxAge:120` means open-ended. Some names carry trailing spaces (`"Public Skate "`) — trim. Note `EventTimeDescription` uses zero-padded hours here (`01:00 pm`) — the existing `timeRe` handles it.

### 4.5 Venues (feed `Address`; Nelson via Nominatim)
| Venue | Address | Postal | Lat, Lng | Skate / all (28 d) |
|---|---|---|---|---|
| Aldershot Arena | 494 Townsend Ave | L7T 2B3 | 43.316465, -79.833132 | 9/9 |
| Appleby Ice Centre (Skate Hub: free skate lending, Arena A) | 1201 Appleby Line | L7S 1E4 | 43.38674, -79.775557 | 31/73 |
| Central Arena | 519 Drury Lane | L7R 2H2 | 43.335167, -79.792986 | 27/80 |
| Mainway Ice Centre | 4015 Mainway | L7P 3N9 | 43.372749, -79.795877 | 0/8 (sticks & pucks only) |
| Mountainside Community Centre (rink) | 2205 Mount Forest Dr | feed says `L7L 4L8` (wrong); Nominatim **L7P 1H4** | 43.352526, -79.822977 | 6/12 |
| Nelson Arena (no drop-in skates in window) | 4235 New St | L7L 5M9 (Nominatim) | 43.3607669, -79.7631809 | 0/0 |
| Skyway Community Centre | 129 Kenwood Ave | L7M 1V8 | 43.368761, -79.733246 | 11/19 |

Burlington Rotary Centennial Pond (outdoor, free, no booking) is not on the calendar.

### 4.6 Prices
Class page "Fees": **Drop In Adult (19–59) $3.50, Adult (60+) $3.50, Youth (2–18) $3.50** — flat $3.50 for all skates (`PriceRange "$0.00 - $3.50"`; $0 = pass holders; skate yearly pass and 10/20/40-day shinny passes exist). burlington.ca itself says "check the program schedule for the fee".

### 4.7 Alerts — HTML only
* `https://www.burlington.ca/Modules/News/en/Closures?_mid_=10394` = news category "Facility, Sports Field and Pool Closures" (4 items today, e.g. "Annual Maintenance Facility Shutdown"). Markup: `<div class="blogItem …"><div class="blogItem-contentContainer">` title / "Posted on …" / teaser. RSS probes (`?feed=rss`, `/rss/Closures`, `/en/rss.aspx`) return HTML/404; `subscribe.burlington.ca` is e-mail only. Scrape feasibility: easy (static HTML, 4 items).
* PerfectMind states: `Register` / `More Info` / `Closed`; `Spots "N spots left"`.

### 4.8 Suggested entry
```js
'burlington': {
    kind: 'perfectmind',
    base: 'https://cityofburlington.perfectmind.com/22818',
    widgetId: '8d8b4749-9c4e-4762-be93-fe54f1e1203b',      // "Recreational Skating Drop In Programs"
    calendarId: '517e0420-1478-458e-8a6f-ad813e278ec0',    // shared skating + sticks-and-pucks calendar
    daysAhead: 28,
    windowDays: 3,
    include: /^(public skate|skate 19\+|sensory skate)/i,
    paid: true,
    venues: {
        'Aldershot Arena': { address: '494 Townsend Ave', district: 'Burlington', postalCode: 'L7T 2B3', lat: 43.316465, lng: -79.833132 },
        'Appleby Ice Centre': { address: '1201 Appleby Line', district: 'Burlington', postalCode: 'L7S 1E4', lat: 43.38674, lng: -79.775557 },
        'Central Arena': { address: '519 Drury Lane', district: 'Burlington', postalCode: 'L7R 2H2', lat: 43.335167, lng: -79.792986 },
        'Mainway Ice Centre': { address: '4015 Mainway', district: 'Burlington', postalCode: 'L7P 3N9', lat: 43.372749, lng: -79.795877 },
        'Mountainside Community Centre': { address: '2205 Mount Forest Dr', district: 'Burlington', postalCode: 'L7P 1H4', lat: 43.352526, lng: -79.822977 },
        'Nelson Arena': { address: '4235 New St', district: 'Burlington', postalCode: 'L7L 5M9', lat: 43.360767, lng: -79.763181 },
        'Skyway Community Centre': { address: '129 Kenwood Ave', district: 'Burlington', postalCode: 'L7M 1V8', lat: 43.368761, lng: -79.733246 }
    },
    defaultDistrict: 'Burlington',
    registrationUrl: () => 'https://cityofburlington.perfectmind.com/22818/Clients/BookMe4BookingPages/Classes?calendarId=517e0420-1478-458e-8a6f-ad813e278ec0&widgetId=8d8b4749-9c4e-4762-be93-fe54f1e1203b&embed=False',
    infoUrl: 'https://www.burlington.ca/en/recreation/skating.aspx'
}
```

---

## 5. PerfectMind `ClassesV2` — behaviour that the current `fetchPerfectMind` must handle

Verified against all three towns (Markham may simply be small enough not to hit it):

1. **Windowing**: `page=N` returns the 14-day window starting today + 14·N days (`numberOfDaysToLoad: 14` in the widget settings). `dateString`, `date`, `startDate`, `numberOfDaysToLoad`, `pageSize` are all ignored.
2. **Truncation**: within a window the server stops after the first whole days that reach ≥ ~50 classes (Brampton page 0 = 64 classes / 5 days; Oakville 51 / 11 days) and `nextKey` = last returned day. The next `page` does **not** resume from `nextKey` — it jumps to the next 14-day window, so days are silently lost (Brampton lost 20 of 28 days).
3. **Fix**: the widget filter **Date Range** (`GET …/BookMe4V2/GetWidgetFilterGroupsV2?calendarId=…&widgetId=…` lists groups; kind 6 = Date Range, kind 5 = Location, kind 8 = Days of week, kind 2 = Service, kind 0 = Age). Post
   `values[0][value]=<from>&values[0][value2]=<to>&values[0][valueKind]=6` with `page=0`; keep windows small enough to stay under ~50 classes (7 days Oakville, 3 Burlington, 1 Brampton) — or adaptively: if a window returns ≥ 50 classes, re-fetch it day by day. Per-Location filtering (`valueKind=5`, GUID from the filter list) also works and also returns complete windows.
4. Each class carries `Address {Street, City, PostalCode, Latitude, Longitude}` → the fetcher can populate venue coords from the feed and use `cfg.venues` only as an override (Mountainside's postal code is wrong in the feed) and as the rink-inventory list.
5. Per-class deep link that shows live fee tiers/spots (HTML): `${base}/Clients/BookMe4LandingPages/Class?widgetId=<widget>&classId=<EventId>&occurrenceDate=<yyyymmdd>` — verified for all three towns.
6. Useful fields: `Spots` (`"42 spots left"`, `"Full"`, `""`), `BookButtonText`, `Facility` (pad name), `CourseIdTrimmed`, `DurationInMinutes`, `Details` (rules text). `EventId + OccurrenceDate` is unique (checked).
7. CORS: `access-control-allow-origin` = the PerfectMind host itself, so the client cannot poll `Spots` live; CI snapshot only (same as toronto.ca).

Suggested `fetchPerfectMind` changes: build the URL from `cfg.base` (which now includes the org path); loop `windowDays` windows from today to today+daysAhead using the Date Range filter (`httpPostJSON` with the `values[0][…]` keys); apply `cfg.include`/`cfg.cleanName`/`cfg.venueAliases`; take `venue` coords from `c.Address` when `cfg.venues[name]` is absent; keep the existing time/price/age parsing (it handled every sample above).

---

## 6. Other verified facts worth keeping

* ActiveNet activity **page** HTML (`activity/search/detail/<id>`) is a JS shell — do not scrape it; use the REST detail.
* ActiveNet `rest/activities/list` needs the `page_info` **request header** (JSON string); `total_records_per_page` is capped at 20.
* Nominatim (User-Agent set): "Joshua's Creek Arenas, Oakville" → 43.4917310, -79.6761115 (L6H 7G5); "Nelson Arena, Burlington" → 43.3607669, -79.7631809 (4235 New St, L7L 5M9); "2205 Mount Forest Drive, Burlington" → 43.3520832, -79.8218324 (L7P 1H4).
* Brampton's SharePoint `_vti_bin/listdata.svc` is 403 and the list's `AllItems.aspx` requires login; only the `_api/web/lists/getbytitle('Service Disruptions')/items` route on the `/EN/City-Hall/Accessibility` sub-web is public.
* Mississauga WordPress REST is open (`/wp-json/`, CORS `*`); `com/v1/lists/site_wide_alerts` and `wp/v2/news?search=` are the only alert-ish routes (no arena-specific notices).
* Oakville's PerfectMind Service filter distinguishes "Recreational Skating Drop-in" (`00d447fa-7301-4b86-a2a4-8299c85f72ad`) from "Shinny Hockey Drop-in" (`7ac5e2b2-bfd6-456f-a404-9c7f867981c0`) — an alternative to a name regex (`values[0][valueKind]=2`).
