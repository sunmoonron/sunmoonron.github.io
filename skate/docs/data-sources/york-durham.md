# Drop-in skating data sources: York & Durham municipalities

Researched 2026-09-14 from Node 25 / curl on this Mac, no browser (one Browser-pane look at the Stouffville and Vaughan
booking pages only to confirm what humans see). Every endpoint below was actually executed; samples are trimmed from
real responses saved in this scratchpad directory.

Scope: Markham, Richmond Hill, Whitchurch-Stouffville, Ajax, Oshawa, plus bonus Pickering and Vaughan.

## TL;DR

| Municipality | Platform behind drop-in skating | Feasibility | Paid? |
|---|---|---|---|
| Markham | PerfectMind (`cityofmarkham.perfectmind.com`), one "Skating" calendar city-wide | **API, already wired** — but see paging + price bugs below | Paid (~$5.17 adult, $13.45 family) |
| Vaughan | PerfectMind (`vaughan.perfectmind.com/25076`), calendar "Skating & Shinny Hockey" | **API — same fetcher, 2 config tweaks** | **Free** (Ticket Ice $10.50) |
| Richmond Hill | ActiveNet (`anc.ca.apm.activecommunities.com/richmondhill`) + HTML tables on richmondhill.ca | **API** (online-calendar events for Ed Sackfield; activity meeting-patterns for the other 3 arenas) or HTML grid scrape | Paid ($5.90 adult skate; $8.70 shinny/figure/stick&puck) |
| Whitchurch-Stouffville | ActiveNet (`…/townofws`) "Skating & Shinny" online calendar — **published empty**; real schedule is a PDF | API exists but unpopulated as of today → PDF scrape (medium-low) | Paid ($5.50 adult skate) |
| Ajax | Town website (new WordPress site) → Publitas flipbook → PDF; ActiveNet (`…/ajax`) has **no** skating | PDF scrape (medium); nothing machine-native | Paid ($5.25 adult skate) |
| Oshawa | Intelligenz "activeOshawa Online" (`register.oshawa.ca/OSHAWA/…`) behind a Queue-it cookie gate | **HTML scrape, clean server-rendered schedule**, 1 request per arena for 28 days (needs cookie jar) | Paid ($5.25 adult; shinny $8.50) |
| Pickering | pickering.ca HTML tables; ActiveNet (`…/cityofpickering`) has lessons only, online calendars "No license" | HTML grid scrape (small, stable) | **Free** |

Cross-cutting findings that affect the existing code (`fetch-skate-data.js`):

1. **PerfectMind `ClassesV2` paging is not "page N = next chunk".** `page` is a *window index* and `after` is a *date
   cursor inside that window*; each response is capped at ~50 rows. The current `fetchPerfectMind` posts `page: 0`
   only, so Markham today yields 51 sessions ending 2026-10-02 and logs the "feed ends … window wants …" warning —
   i.e. it silently drops Oct 3–12. Looping `after = nextKey` on `page 0` returned **487 Markham sessions through
   Dec 29 in 10 calls**. Algorithm verified on both cities (section 1.3).
2. **PerfectMind does return venue coordinates.** Every class row has `Address: {AddressTag, Street, City, PostalCode,
   Latitude, Longitude}`. The comment "PerfectMind doesn't return them" is wrong; `venues{}` can be auto-filled
   (Woodbridge Arena in Vaughan is the one venue with `Latitude: null`). The existing hard-coded Angus Glen point
   (43.904173, -79.308765) is ~2.4 km east of the building; API + Nominatim agree on 43.8954, -79.3365.
3. **`PriceRange` max is the *family* tier, not the adult rate.** Markham "Drop-In Recreational Skate" = `$0.00 - $13.45`
   (family ticket; adult drop-in is $5.02 + HST ≈ $5.17 per the 2025-26 Schedule of Fees, and shinny/stick&puck rows
   show `$0.00 - $5.17`). `Math.max(prices)` therefore labels Markham skates "$13.45". Vaughan rows say `No fee`
   (→ should map to 0 / free, not `null`).
4. ActiveNet has a public, unauthenticated JSON API that is the same for every ActiveNet city
   (`/rest/onlinecalendar/*`, `/rest/activities/list`, `/rest/activity/detail/*`). One new fetcher kind covers
   Richmond Hill now and Stouffville/Ajax/Pickering whenever they start publishing.

---

## 1. City of Markham — PerfectMind (verified, already integrated)

**Platform:** PerfectMind/Xplor BookMe4. Drop-in widget `6825ea71-e5b7-4c2a-948f-9195507ad90a` ("Drop-In Programs &
Activities Start Page"). Its category list (`POST /Clients/BookMe4V2/GetCategoriesDataV2?embed=False`, form body
`widgetId=…`) contains exactly one skating calendar: **`Skating` = `ecf5202d-4c97-4f89-b4e3-42966a1cc453`** (the one
already in config). The other Markham widget (`bfd08479-…`, "Registered Programs") only has "Skating & Hockey"
*lesson* calendars — not drop-in. So one calendar really is city-wide.

### 1.1 Working request (unchanged) + verified paging

```
POST https://cityofmarkham.perfectmind.com/Clients/BookMe4BookingPagesV2/ClassesV2
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
body: calendarId=ecf5202d-4c97-4f89-b4e3-42966a1cc453&widgetId=6825ea71-e5b7-4c2a-948f-9195507ad90a&page=0[&after=YYYY-MM-DD]
```
Response: `{ classes: [...], classesMaxEndDateString, nextKey }`. No cookies, no Referer needed.

Verified cursor loop (page 0, `after` = previous `nextKey`, stop on 0 rows / `nextKey` `0001-01-01`):

| call | after | rows | dates | nextKey |
|---|---|---|---|---|
| 1 | – | 51 | 2026-09-14 → 10-02 | 2026-10-02 |
| 2 | 2026-10-02 | 50 | 10-03 → 10-15 | 2026-10-15 |
| 3 | 2026-10-15 | 54 | 10-16 → 10-26 | 2026-10-26 |
| … | … | … | … | … |
| 10 | 2026-12-19 | 13 | 12-20 → 12-29 | 2026-12-29 |

Total 487 unique sessions (dedupe key `EventId|OccurrenceDate|EventTimeDescription`). `page=1` with or without `after`
returns 0 rows for Markham (its single window covers the whole published season), whereas Vaughan needs `page` 0,1,2…
(14-day windows) — the loop in 1.3 handles both.

### 1.2 Distinct `Location` strings (28-day run, 2026-09-14 → 10-12) and API-supplied addresses

| `Location` (exact) | Street (API) | Postal | Lat, Lng (API) | Nominatim check | Facility strings | Events seen |
|---|---|---|---|---|---|---|
| `Angus Glen Community Centre` | 3990 Major Mackenzie Drive | L6C 1P8 | 43.895354, -79.336539 | 43.8946, -79.3363 ✓ | `Arena: East - Rink`, `Arena: West - Rink` | Rec Skate, Shinny Adults 30+ |
| `Crosby Community Centre` | 210 Main Street Unionville | L3R 2G9 | 43.868535, -79.313304 | 43.8688, -79.3125 ✓ | `Arena: Rink` | Rec Skate, Shinny Adults, Stick & Puck |
| `Milliken Mills Community Centre` | 7600 Kennedy Road | L3R 9S5 | 43.840228, -79.305006 | 43.8396, -79.3051 ✓ | `Arena: Rink` | Rec Skate, Stick & Puck 16+, Stick & Ring |
| `Thornhill Community Centre` | 7755 Bayview Avenue | L3T 4P1 | 43.820032, -79.399873 | 43.8193, -79.4011 ✓ | `Arena: East - Rink`, `Arena: West - Rink` | Rec Skate, Rec Skate 55+, Parent & Tot, Stick & Puck, Stick & Ring |
| `Markham Village Community Centre` | 6041 Highway 7 | L3P 3A7 | 43.873298, -79.258153 | 43.8737, -79.2581 ✓ | `Arena: Rink` | Rec Skate |
| `Mount Joy Community Centre` | 6140 16th Avenue East | L3P 3K8 | 43.895012, -79.262293 | 43.8933, -79.2592 ✓ | `Arena: Rink` | Rec Skate |

Centennial CC and Cornell CC never appear on the skating calendar in the whole published season (Sep 14 – Dec 29), so
they host no drop-in skating right now. Event names seen: `Drop-In Recreational Skate`, `Drop-In Recreational Skate 55+`,
`Drop-In Parent & Tot Skate`, `Drop-In Shinny: Adults`, `Drop-in Shinny: Adults (30+)`, `Drop-In Stick & Puck`,
`Drop-In Stick & Puck (16+)`, `Drop-In Stick & Ring` (some with trailing spaces — trim). Ages: `AgeRestrictions`
"1+", "3+", "16+", "30+", "40+", "55+".

Trimmed sample rows (EventName | Location | OccurrenceDate | EventTimeDescription | PriceRange | Ages | Spots | Facility):
```
Drop-In Recreational Skate | Angus Glen Community Centre | 20260914 | 04:15 pm - 06:05 pm | $0.00 - $13.45 | 1+ | 141 spots left | Arena: East - Rink
Drop-In Shinny: Adults     | Crosby Community Centre     | 20260916 | 11:30 am - 01:00 pm | $0.00 - $5.17  | 16+ | Full | Arena: Rink
Drop-In Recreational Skate | Crosby Community Centre     | 20260919 | 08:10 pm - 10:00 pm | $0.00 - $13.45 | 3+ | 118 spots left | Arena: Rink
```

Prices (Markham Schedule of Fees 2025-26, "Recreation Drop-In Ticket — Swim, Skate, Shinny": Adult 16+ $5.02, Child
$3.01, Older Adult $3.52, Family $13.06, all + HST). The API's `$13.45` max = family tier for skates; `$5.17` = adult
tier for shinny/stick&puck. Suggest `price` = adult tier via a per-source `adultPrice` (or "lowest tier above $4").

### 1.3 Suggested `venues{}` block + fetcher change

```js
'markham': {
    kind: 'perfectmind',
    base: 'https://cityofmarkham.perfectmind.com',
    widgetId: '6825ea71-e5b7-4c2a-948f-9195507ad90a',
    calendarId: 'ecf5202d-4c97-4f89-b4e3-42966a1cc453',
    daysAhead: 28,
    paid: true,
    adultPrice: 5.17,   // PriceRange max is the FAMILY ticket; adult drop-in = $5.02 + HST
    // Names must equal PerfectMind's `Location` string exactly. Coords = API Address (Nominatim-checked).
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
}
```

Paging loop for `fetchPerfectMind` (verified with `scratchpad/pmall.js` on both cities; the booking page's own
`ClassBookingV2Controller.js` does exactly this: it re-posts with `after: result.nextKey`, and bumps `page` only after
an empty result):

```js
const seen = new Map();
for (let page = 0; page < 6; page++) {
    let after = null, got = 0;
    for (let k = 0; k < 12; k++) {
        const j = await httpPostJSON(url, { calendarId, widgetId, page, ...(after ? { after } : {}) });
        const cls = j.classes || [];
        if (!cls.length) break;
        cls.forEach(c => seen.set(`${c.EventId}|${c.OccurrenceDate}|${c.EventTimeDescription}`, c));
        got += cls.length;
        if (!j.nextKey || j.nextKey === after || j.nextKey.startsWith('0001')) break;
        after = j.nextKey;
    }
    const maxDate = [...seen.values()].map(c => c.OccurrenceDate).sort().pop();
    if (!got || (maxDate && maxDate > endYYYYMMDD)) break;   // window passed daysAhead
}
```
Also: fill `venue` from `c.Address` when `cfg.venues[c.Location]` is missing (`Street`, `PostalCode`, `Latitude`,
`Longitude`; trim — Vaughan pads its strings with spaces), and treat `PriceRange === 'No fee'` as price 0.

---

## 2. City of Vaughan — PerfectMind (verified; bonus)

**Platform:** PerfectMind at `https://vaughan.perfectmind.com/25076/…` (note the `/25076` client prefix in every path).
Found from vaughan.ca → "Skating & Hockey" page → `BookMe4?widgetId=dff88c8a-0b78-4a94-9dde-250040385300` ("Drop-In
Activities (ALL)"). Its categories (`GetCategoriesDataV2`) are Fitness Centre, **Skating & Shinny Hockey =
`84142d20-1da8-48ed-800d-31dc0c30121d`**, Sports, Swimming & Aquafitness. (`af105a64-…` is the Facility Bookings
widget — ignore.) vaughan.ca itself blocks curl (Akamai 403) but Node `fetch` with a browser UA gets it; not needed
for the weekly run anyway.

### 2.1 Working request

```
POST https://vaughan.perfectmind.com/25076/Clients/BookMe4BookingPagesV2/ClassesV2
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
body: calendarId=84142d20-1da8-48ed-800d-31dc0c30121d&widgetId=dff88c8a-0b78-4a94-9dde-250040385300&page=0[&after=YYYY-MM-DD]
```
Works with the exact headers `httpPostJSON` already sends (verified with Node `https` and curl; no cookies). A
wrong calendarId for this widget answers `302 → /25076/Clients/BookMe4/Error?message=…Calendar is not allowed…`,
so treat 302 as a config error.

Paging here really needs the loop: `page` windows are 14 days (`page 1` starts 2026-09-28, `page 2` 2026-10-12 …)
and each window needs 2–4 `after` calls. 28-day run = **339 sessions in 10 calls** (Sep 14 → Oct 25, no gaps;
Vaughan simply has no weekend sessions on the first two weekends).

### 2.2 Venues (`Location` strings exact; Address from API, trimmed)

| `Location` | Street | City | Postal | Lat, Lng | Facility | Events |
|---|---|---|---|---|---|---|
| `Al Palladini Community Centre` | 9201 Islington Ave. | Woodbridge | L4L 1A7 | 43.816528, -79.597205 | `Arena West (B) Ice In`, `Arena East (A) Ice In` | Skating – Unsupervised; Ticket Ice Figure Skating; Shinny Adult / Goalie / Parent & Child |
| `Rosemount Community Centre` | 1000 New Westminster Dr. | Thornhill | L4J 8G3 | 43.817858, -79.453424 | `Arena (Ice In)` | Skating – Unsupervised; Older Adult Only; Shinny Adult/Goalie |
| `Garnet A. Williams Community Centre` | 501 Clark Ave. West | Thornhill | L4J 4E5 | 43.803966, -79.439973 | `Arena (Ice In)` | Skating – Unsupervised; Shinny Adult/Goalie |
| `Woodbridge Pool & Memorial Arena` | 5020 Highway #7 | Woodbridge | L4L 1T1 | **API null** → Nominatim 43.7802455, -79.5916837 | `Arena (Ice In)` | Skating – Unsupervised; Adult Only |
| `Maple Community Centre` | 10190 Keele St. | Maple | L6A 1R7 | 43.859882, -79.514834 | `Arena (Ice In)` | Skating – Unsupervised; Older Adult Only; Shinny Parent & Child / Goalie |

Event names (all suffixed "Unsupervised"): `Skating - Unsupervised` (ages 3–99), `Skating - Adult Only Unsupervised`
(18+), `Skating - Older Adult Only Unsupervised` (65+), `Skating - Ticket Ice Figure Skating – Unsupervised` (5–65,
`$10.00 - $10.50`), `Shinny - Adult Unsupervised`, `Shinny - Goalie Adult Unsupervised`, `Shinny - Parent & Child
Unsupervised`, `Shinny - Goalie Parent & Child Unsupervised`. **Everything except Ticket Ice is `PriceRange: "No fee"`**
— Vaughan's drop-in skating is free (residents; 20 % non-resident surcharge applies to paid items). Spots are
published (`"75 spots left"`), i.e. free online booking.

Trimmed sample:
```
Skating - Unsupervised            | Al Palladini Community Centre       | 20260914 | 11:00 am - 01:30 pm | No fee          | 3 to 99  |               | Arena West (B) Ice In
Skating - Ticket Ice Figure Skating – Unsupervised | Al Palladini CC   | 20260914 | 02:15 pm - 03:45 pm | $10.00 - $10.50 | 5 to 65  | 25 spots left | Arena West (B) Ice In
Skating - Adult Only Unsupervised | Woodbridge Pool & Memorial Arena    | 20260915 | 10:00 am - 12:00 pm | No fee          | 18 to 99 | 75 spots left | Arena (Ice In)
Skating - Older Adult Only Unsupervised | Maple Community Centre        | 20260915 | 10:00 am - 12:00 pm | No fee          | 65 to 99 | 75 spots left | Arena (Ice In)
```

### 2.3 Suggested entry

```js
'vaughan': {
    kind: 'perfectmind',
    base: 'https://vaughan.perfectmind.com/25076',        // client-id prefix is part of every Vaughan path
    widgetId: 'dff88c8a-0b78-4a94-9dde-250040385300',      // "Drop-In Activities (ALL)"
    calendarId: '84142d20-1da8-48ed-800d-31dc0c30121d',    // "Skating & Shinny Hockey"
    daysAhead: 28,
    paid: false,            // PriceRange "No fee" on every skate/shinny; Ticket Ice is $10.50 → keep per-record price
    programs: [{ match: /^Skating|^Shinny/i }],           // optional filter; calendar is skating-only anyway
    venues: {
        'Al Palladini Community Centre':       { address: '9201 Islington Ave',      district: 'Vaughan', postalCode: 'L4L 1A7', lat: 43.816528, lng: -79.597205 },
        'Rosemount Community Centre':          { address: '1000 New Westminster Dr', district: 'Vaughan', postalCode: 'L4J 8G3', lat: 43.817858, lng: -79.453424 },
        'Garnet A. Williams Community Centre': { address: '501 Clark Ave W',         district: 'Vaughan', postalCode: 'L4J 4E5', lat: 43.803966, lng: -79.439973 },
        'Woodbridge Pool & Memorial Arena':    { address: '5020 Highway 7',          district: 'Vaughan', postalCode: 'L4L 1T1', lat: 43.7802455, lng: -79.5916837 },
        'Maple Community Centre':              { address: '10190 Keele St',          district: 'Vaughan', postalCode: 'L6A 1R7', lat: 43.859882, lng: -79.514834 }
    },
    defaultDistrict: 'Vaughan',
    registrationUrl: () => 'https://vaughan.perfectmind.com/25076/Clients/BookMe4BookingPages/Classes?calendarId=84142d20-1da8-48ed-800d-31dc0c30121d&widgetId=dff88c8a-0b78-4a94-9dde-250040385300&embed=False',
    infoUrl: 'https://www.vaughan.ca/residential/recreation-programs-and-fitness/skating-hockey'
}
```
Fetcher tweaks needed: (a) the paging loop from 1.3; (b) `PriceRange === 'No fee'` → `price = 0` and mark the
record free even when `cfg.paid` is false (Ticket Ice stays paid via its own PriceRange); (c) trim `Address` strings.

---

## 3. City of Richmond Hill — ActiveNet (verified) + HTML tables

**Platform:** ActiveNet ("ActiveRH"), org slug `richmondhill`. richmondhill.ca links only to ActiveNet for
registration; the drop-in skating schedule is *also* rendered as HTML grids on
`https://www.richmondhill.ca/en/things-to-do/Skating.aspx`. Tickets are sold **in person only** (no online booking),
so sessions in ActiveNet are informational activities (`allow_drop_in_reg: false`).

Two verified machine-readable routes:

### 3.1 Online-calendar events (best for Ed Sackfield; per-date rows)

```
GET  https://anc.ca.apm.activecommunities.com/richmondhill/rest/onlinecalendar/calendars?locale=en-US
     → calendars: 13 "Adults 55+ Members Only", 1 "Recreational Activities", 12 "Skating & Shinny", 11 "Swimming & Aquafit"
POST https://anc.ca.apm.activecommunities.com/richmondhill/rest/onlinecalendar/filters?locale=en-US
     Content-Type: application/json;charset=utf-8   body: {"calendar_id":12}
     → center [27 "Ed Sackfield Arena and Fitness Centre"], activities (6 drop-ins), facilities (182 North pad, 610 South pad),
       calendar_period {"start_date":"2026-09-14","end_date":"2026-10-05"}   ← server-side rolling window (~3 weeks)
POST https://anc.ca.apm.activecommunities.com/richmondhill/rest/onlinecalendar/multicenter/events?locale=en-US
     Content-Type: application/json;charset=utf-8
     body: {"calendar_id":12,"center_ids":[27]}
     (optional: "display_all":0|1|2 (int only — boolean → HTTP 500), "activity_ids":[…], "facility_ids":[…])
```
No auth, no cookies, no `page_info` header needed. Response `body.center_events[].events[]`:
`title, start_time "2026-09-28 19:15:00", end_time, event_type, description (HTML), event_item_id (= activity id),
activity_detail_url, facilities[{facility_name, center_id, center_name}], price, action_link`. 17 events returned for
center 27 in the current period. Trimmed:
```
Public Skating - Fall 2026 - Ed Sackfield Arena | 2026-09-28 19:15 → 20:45 | Ed Sackfield - South Arena Ice Pad | 146246
Public Skating - Fall 2026 - Ed Sackfield Arena | 2026-09-30 11:15 → 12:15 | Ed Sackfield - South Arena Ice Pad | 146246
Public Skating - Fall 2026 - Ed Sackfield Arena | 2026-10-03 13:15 → 14:15 | Ed Sackfield - South Arena Ice Pad | 146246
40+ Drop in Shinny - Fall 2026 - Ed Sackfield Arena | 2026-10-02 10:15 → 11:15 | Ed Sackfield - South Arena Ice Pad | 146267
```
Limitation: calendar 12 only carries **Ed Sackfield** (brute-forcing `center_ids` 1..120 on calendars 12/1/13/11
confirmed no other arena is on any online calendar). The period is ~3 weeks, shorter than 28 days.

### 3.2 Activity search + meeting patterns (covers all four arenas, whole season)

```
POST https://anc.ca.apm.activecommunities.com/richmondhill/rest/activities/list?locale=en-US
     Content-Type: application/json;charset=utf-8
     page_info: {"order_by":"","page_number":1,"total_records_per_page":100}
     body: {"activity_search_pattern":{"activity_select_param":2,"activity_keyword":"Public Skat","center_ids":[],
            "skills":[],"days_of_week":null,"activity_category_ids":[],"activity_type_ids":[],"site_ids":[],
            "season_ids":[],"instructor_ids":[],"open_spots":null,"min_age":null,"max_age":null,
            "time_after_str":"","time_before_str":"","date_after":"","date_before":"","for_map":false,
            "geographic_area_ids":[],"activity_department_ids":[],"activity_other_category_ids":[],
            "child_season_ids":[],"custom_price_from":"","custom_price_to":""},"activity_transfer_pattern":{}}
```
Keywords that hit: `Public Skat` (10 activities), `Shinny`, `Figure Skat`, `Stick and Puck`, `Ringette`. Items:
`id, name, location.label, date_range, days_of_week, time_range, fee.label, ages, allow_drop_in_reg`. Current ice
drop-ins:
```
146246 Public Skating - Fall 2026 - Ed Sackfield Arena   Sep 28–Dec 30  Sun,Mon,Wed,Fri,Sat  "View fee details"
146253 Public Skating - Fall 2026 - Tom Graham Arena     Oct 2–Dec 27   Sun,Fri
146258 Public Skating - Fall 2026 - Bond Lake Arena      Oct 3–Dec 27   Sun,Sat
146254 Public Skating - Fall 2026 - Elgin Barrow Arena   Oct 3–Dec 19   Sat 7:15–8:45 PM
148693/148690/148691/148692  Public Skating - Winter 2027 - (same four arenas)  Jan 2–Mar 31
148747 Public Skating - Winter Break (Ed Sackfield, Dec 21–30)   148748 … March Break (Mar 15–17)
146265 Drop in Shinny - Fall 2026 - Ed Sackfield  Wed,Fri 12:15–1:45 PM  $8.70  16+
146267 40+ Drop in Shinny - Fall 2026 - Ed Sackfield  Fri 10:15–11:15 AM  $8.70  40+
146264 Drop in Figure Skating - Fall 2026 - Ed Sackfield  Mon,Thu,Sat 8:45–9:45 PM  $8.70
146278 Childrens/Family Stick and Puck - Fall 2026 - Ed Sackfield  Sun,Thu  $8.70
```
`time_range` is garbage for multi-weekday activities ("7:15 PM - 12:15 PM on the next day"), so expand with:
```
GET https://anc.ca.apm.activecommunities.com/richmondhill/rest/activity/detail/meetingandregistrationdates/146253?locale=en-US
→ body.meeting_and_registration_dates:
  activity_patterns: [{ beginning_date:"2026-10-02", ending_date:"2026-12-27", exception_dates:["25,27 Dec 2026"],
                        pattern_dates:[{weekdays:"Sun", starting_time:"14:30:00", ending_time:"16:00:00"},
                                       {weekdays:"Fri", starting_time:"19:00:00", ending_time:"20:30:00"}] }],
  additional_dates: [{ meeting_date:"2026-12-27", weekdays:"Sun", starting_time:"14:45:00", ending_time:"16:15:00" }]
```
(146246 gives `weekdays:"Wed, Fri"` combos and `exception_dates:["12 Oct 2026","25,26 Dec 2026"]`.) Expanding
`pattern_dates` × weekdays over `beginning_date..ending_date`, minus `exception_dates`, plus `additional_dates`,
reproduces the website grid exactly (Tom Graham Sun 2:30–4 with the Dec 27 time change). Note the pattern lists a
Friday 7–8:30 PM at Tom Graham that the website grid omits — trust the API or cross-check, your call.
`GET /rest/activity/detail/146253?locale=en-US` gives `facilities[{name:"Tom Graham - Richmond Hill Honda Rink"}]`,
`first_date/last_date`, `age_description` if needed.

### 3.3 HTML fallback

`https://www.richmondhill.ca/en/things-to-do/Skating.aspx` has 5 `<table class=" datatable">` grids (Skating, Shinny,
Stick & Puck, Figure Skating, Ringette), each 8 columns `Location | Sunday … Saturday`, cells like `2:30 - 4 p.m.`,
`11:15 a.m. - 12:15 p.m.`, occasionally two stacked times or notes ("Time change on December 27 only: …"), season
header text "Skating Schedule: September 28 - March 31, 2027", and "Exclusion Dates: October 12, December 20, 25, 26,
January 1, 30, 31, March 26, 28". Scrape feasibility medium (needs a grid parser; the existing `parseScheduleText`
expects "Tuesday: 12 – 1 pm" prose).

### 3.4 Prices (richmondhill.ca, 2026-27)

Recreational skate: Adult $5.90 / Child $3.55 / Senior $4.15 / Group $14.35 (10-visit passes and a Sept–Mar Skate
Membership exist). Shinny, Stick & Puck, Figure Skating: $8.70 single, $78 for 10. Goalies free at shinny.
Tickets at the arena desk from 30 min before.

### 3.5 Venues (address from richmondhill.ca Arenas page + ActiveNet `centerdetails`; coords Nominatim)

| Venue (ActiveNet center id) | Address | Postal | Lat, Lng | Drop-in skating? |
|---|---|---|---|---|
| Ed Sackfield Arena and Fitness Centre (27) | 311 Valleymede Dr | L4B 2E1 | 43.8571076, -79.3989503 | yes — public skate, shinny, 40+ shinny, stick & puck, figure, ringette |
| Tom Graham Arena (107) | 1300 Elgin Mills Rd E | L4S 1M5 | 43.8988901, -79.4024357 | public skate Sun; ringette Sun |
| Bond Lake Arena (13) | 70 Old Colony Rd | L4E 3G4 | 43.9392400, -79.4468724 | public skate Sun & Sat; shinny |
| Elgin Barrow Arena (28) | 43 Church St S | L4C 1W1 | 43.8746833, -79.4363835 | public skate Sat; shinny |
| Elvis Stojko Arena (31) | 350 16th Ave | L4C 7A9 | 43.8552821, -79.4235985 | lessons/rentals only — no drop-ins in Fall 2026 |
| Richmond Green Skate Trail (97 "Richmond Green") | 1300 Elgin Mills Rd E (beside Tom Graham) | L4S 1M5 | 43.8989, -79.4024 | **outdoor**, free, no schedule: 10 a.m.–10 p.m. daily weather permitting, status line on Outdoor-Skating.aspx ("Status : Closed" today) |
| Bayview Hill outdoor rink | 114 Spadina Rd | — | 43.8696442, -79.4020011 | outdoor, free, same hours/status model |

"Richmond Green" has no indoor ice; it is the skate trail (plus Mill Pond / Lake Wilcox natural ice). Bond Lake and
Elvis Stojko were closed for maintenance Apr 20 – Sep 7, 2026 (reopened).

### 3.6 Suggested entry (new kind)

```js
'richmondhill': {
    kind: 'activenet',
    org: 'richmondhill',
    // (a) online calendar → per-date rows (Ed Sackfield); (b) activity keywords → meetingandregistrationdates
    //     expansion for arenas that are not on the calendar. Both are public JSON, no auth.
    calendarId: 12, centerIds: [27],
    activityKeywords: ['Public Skat', 'Shinny', 'Figure Skat', 'Stick and Puck', 'Ringette'],
    activityMatch: /skat|shinny|stick and puck|ringette/i,     // drop lessons ("Learn to Skate", "Power Skating")
    daysAhead: 28,
    paid: true,
    prices: [{ match: /public skating/i, price: 5.90 }, { match: /.*/, price: 8.70 }],
    // key = ActiveNet location.label / center_name
    venues: {
        'Ed Sackfield Arena and Fitness Centre': { address: '311 Valleymede Dr',    district: 'Richmond Hill', postalCode: 'L4B 2E1', lat: 43.8571076, lng: -79.3989503 },
        'Tom Graham Arena':                      { address: '1300 Elgin Mills Rd E', district: 'Richmond Hill', postalCode: 'L4S 1M5', lat: 43.8988901, lng: -79.4024357 },
        'Bond Lake Arena':                       { address: '70 Old Colony Rd',      district: 'Richmond Hill', postalCode: 'L4E 3G4', lat: 43.9392400, lng: -79.4468724 },
        'Elgin Barrow Arena':                    { address: '43 Church St S',        district: 'Richmond Hill', postalCode: 'L4C 1W1', lat: 43.8746833, lng: -79.4363835 },
        'Elvis Stojko Arena':                    { address: '350 16th Ave',          district: 'Richmond Hill', postalCode: 'L4C 7A9', lat: 43.8552821, lng: -79.4235985 }
    },
    defaultDistrict: 'Richmond Hill',
    registrationUrl: () => 'https://www.richmondhill.ca/en/things-to-do/Skating.aspx',   // in-person tickets only
    infoUrl: 'https://www.richmondhill.ca/en/things-to-do/Skating.aspx'
}
```

---

## 4. Town of Whitchurch-Stouffville — ActiveNet calendar (empty) / PDF

**Platform:** ActiveNet org `townofws`. townofws.ca "Skating" and "Drop-in Programs" pages link to
`https://anc.ca.apm.activecommunities.com/townofws/calendars?onlineSiteId=0&defaultCalendarId=3&locationId=13&displayType=0&view=2`
(calendar 3 = **"Skating & Shinny"**, location 13 = Stouffville Arena). Verified endpoints (same shapes as §3.1):

```
GET  …/townofws/rest/onlinecalendar/calendars?locale=en-US        → 9 "55+ Club Activities", 1 "Aquafit", 7 "Group Fitness and Cycle Fit", 6 "Gymnasium", 3 "Skating & Shinny", 5 "Swimming"
POST …/townofws/rest/onlinecalendar/filters?locale=en-US  {"calendar_id":3}   → center [], activity [], facilities [], calendar_period 2026-09-13 → 2026-10-18
POST …/townofws/rest/onlinecalendar/multicenter/events?locale=en-US  {"calendar_id":3,"center_ids":[13,14]}  → events: []  (also [] for center_ids 1..60)
GET  …/townofws/rest/onlinecalendar/centerdetails?center_ids=13,14&locale=en-US
     → 13 "Stouffville Arena" 12483 Ninth Line L4A 1J3 · 14 "Stouffville Clippers Sports Complex" 120 Weldon Road L4A 1N2
```
The Browser pane shows the same: "Skating & Shinny — No items". The other calendars (aquafit, swim, gym, fitness)
*are* populated (49–193 events each), so the Town simply has not loaded skating into ActiveNet this season.
Feasibility: **API-ready but currently returns nothing** — poll it weekly (kind `activenet`, org `townofws`,
calendarId 3, centerIds [13, 14]) and fall back to the PDF.

**PDF (the real published schedule):** `https://www.townofws.ca/media/zkrbulbm/skating-f26_dropin_sep9.pdf`
("Fall 2026 Drop-in Schedule — Skating, September 14 – December 20, 2026", revised Sep 9). Linked from
`https://www.townofws.ca/play/recreation/programs/drop-in-programs/` (href matches `/media/*/skating-*dropin*.pdf`
— the hash path changes each revision, so discover it from that page). `pdftotext -layout` extracts a clean grid:
two blocks (Clippers, Stouffville Arena), header `Activity | Age | Monday … Sunday`, cells like `6:15pm – 8:15pm`,
`PAD 2: 11:15am – 12:15pm`, `Ages 11-14: 7:00pm – 8:00pm`. Column assignment must be done by x-offset (layout text).
Feasibility medium-low (PDF, column alignment, per-season URL). Node has no PDF text extraction without a dependency
(`pdf-parse`, or `apt-get install poppler-utils` in CI).

Extracted fall 2026 schedule:
- **Stouffville Clippers Sports Complex** (120 Weldon Rd): Public Skate Sun 6:15–8:15 pm; Parent & Tot (6 & under) Fri 9:15–10:15 am;
  Youth Shinny Sat 7–8 pm (11–14) / 8–9 pm (14–17); Adult/Senior Free Skate 18+ Tue 1–2:30 pm, Thu 12:30–2 pm, Fri 10–11:30 am;
  Adult/Senior Shinny Fri 11:15 am–12:15 pm (Pad 2).
- **Stouffville Arena** (12483 Ninth Line): Public Skate Sat 3–5 pm; Family Stick & Puck (4–10 w/ adult) Mon 4:15–5:15,
  Thu 4:15–5:15, Fri 4–5 pm (Pad A); Youth Shinny 11–14 Fri 4:15–5:15 pm (Pad B).
- Fees (incl. HST): Skate — Tot $2.50, Youth $3.50, Adult $5.50, Senior $3.50, Family $12.50; Stick & Puck/Shinny —
  $4.50 / $5.50 / $7.50 / $5.50 / $17.50. Cash/debit/credit at the door, 15 min before.

Venues (Nominatim; the Town's addresses):

| Venue | Address | Postal | Lat, Lng |
|---|---|---|---|
| Stouffville Arena (center 13) | 12483 Ninth Line | L4A 1J3 (Town) | 43.9742243, -79.2553137 (name match, "Recreation Lane") |
| Stouffville Clippers Sports Complex (center 14) | 120 Weldon Rd | L4A 1N2 | 43.9650556, -79.2617345 |

Suggested entry: same `activenet` kind as Richmond Hill with `org: 'townofws', calendarId: 3, centerIds: [13, 14]`,
`unverified: true` until it returns rows; `infoUrl: 'https://www.townofws.ca/play/recreation/skating/'`.

---

## 5. Town of Ajax — website + Publitas PDF (no API)

**Platform:** ajax.ca moved to a new CMS; every old `/en/…/*.aspx` URL returns nginx **403** (also in a real
Chrome — they are dead, not bot-blocked). Current page: `https://ajax.ca/explore/parks-recreation/sports-recreation/skating/`
("Public Skating & Ice Schedules"), fetchable from Node with a browser UA. It has inline wpDataTables for prices and
Ticket Ice, but the **Fall Skate Schedule is a Publitas flipbook**:
`https://view.publitas.com/ajax/skating-schedule_fall-2026_handout_11x17/page/2`. That page's HTML contains a direct
PDF link (`https://view.publitas.com/27472/3333303/pdfs/e2526d8e-….pdf?response-content-disposition=…`, 553 KB,
2 pages) which `pdftotext -layout` extracts cleanly:

```
Skating Schedule — Effective September 8 to December 18, 2026
Ajax Recreation Centre
 Monday      10 - 11 a.m.          Parent & Tot     Pad 2   Unavailable Oct. 12
 Tuesday     8:45 - 10:15 a.m.     Stick n Puck     Pad 1   Unavailable Dec. 24, 31
             10:15 - 11:45 a.m.    Adult Skate      Pad 1   Unavailable Dec. 24, 31
             11 a.m. - 12 p.m.     Ticket Ice       Pad 2   -
             11:45 a.m. - 1:15 p.m. Adult Shinny    Pad 1   Unavailable Dec. 24, 31
 Wednesday   10 - 11:30 a.m. Ladies Shinny Pad 2 · 2 - 3 p.m. Parent & Tot Pad 2 · 4:15 - 6:05 p.m. Public Skating Pad 1 · 10:15 - 11:15 p.m. Adult Shinny Pad 1
 Thursday    7:30 - 8:30 a.m. Ticket Ice Pad 1 · 8:45 - 10:15 Stick n Puck · 10:15 - 11:45 Adult Skate · 11:45 a.m. - 1:15 p.m. Adult Shinny
 Friday      8:45 - 10:15 a.m. Sledge Shinny Pad 1 (Unavailable Oct. 9, Nov. 27, Dec. 4) · 11 a.m. - 12 p.m. Ticket Ice Pad 2 · 6:15 - 8:05 p.m. Public Skating Pad 1
 Saturday    7:15 - 8:15 a.m. Ticket Ice Pad 1 (Unavailable Oct. 10, Nov. 28, Dec. 5) · 12:15 - 2:05 p.m. Public Skating Pad 1
 Sunday      12:15 - 2:05 p.m. Public Skating Pad 1
```
Discovery chain for a weekly job: skating page → `href` containing `view.publitas.com/ajax/skating-schedule` →
that HTML → regex `https://view.publitas.com/\d+/\d+/pdfs/[^"]+\.pdf[^"]*` → PDF → text. Three hops, all plain GET,
plus a PDF-text step. Feasibility **medium** (PDF layout is regular: `time  activity  pad  exceptions` per line under
weekday headings). Rate: the flipbook name embeds the season, so expect to re-discover each season.

ActiveNet (`…/ajax`, "ActiveAjax") is used for registration but has **no skating**: `activities/list` keyword
`Skat/skate/shinny/public skating/stick` → only "Skateboarding Basics"; online calendars are Aqua Fitness, Group
Fitness, Inclusion, Kids/Pre-School Friday Night Fun, Recreational Activities (sports at McLean CC id 5 & Audley id 36),
Youth Spaces. Ajax Community Centre is center id 3 there, should they ever add a skating calendar.

**Venues:** Ajax has one arena — **Ajax Community Centre**, 75 Centennial Rd, Ajax L1S 4L1 (4 pads; the PDF calls it
"Ajax Recreation Centre"); Nominatim 43.8393724, -79.0206406. **Audley Recreation Centre** (1955 Audley Rd N, L1Z 0L2;
43.8977223, -79.0065157 via its library-branch match) has **no ice** — pool/gym/library. Outdoor: Pat Bayly Square
rink (free, seasonal, closed now).

**Prices (fall 2026):** Skating admission (Public, Parent & Tot, Adult Stick & Puck, Adult Skate): Youth & 65+ $3.50
(10 for $30.85), Adult $5.25 (10 for $48.40), 3 & under free, Group $16.10. Shinny/Sledge: Youth & 65+ $5.65 (5 for
$25.10), Adult $7.90 (5 for $35.60). Ticket Ice $11.90 (Skate Canada members only).

Suggested entry: `kind: 'pdf-grid'` (new) with `discover: { page: 'https://ajax.ca/explore/parks-recreation/sports-recreation/skating/', linkMatch: /view\.publitas\.com\/ajax\/skating-schedule/ , pdfMatch: /\/pdfs\/[^"]+\.pdf[^"]*/ }`,
`locationName: 'Ajax Community Centre'`, `address: '75 Centennial Rd'`, `postalCode: 'L1S 4L1'`, `lat: 43.8393724, lng: -79.0206406`,
`paid: true`, `unverified: true`. Honest recommendation: defer unless a PDF-text dependency is acceptable.

---

## 6. City of Oshawa — Intelligenz ("activeOshawa Online") behind Queue-it (verified)

**Platform:** `https://register.oshawa.ca/OSHAWA/…` (scripts `inzUtils.js` → Intelligenz). oshawa.ca "Leisure Skating"
links three category pages: `SKATEDHC` (Delpark Homes Centre), `SKATEDRC` (Donevan Recreation Complex), `SKATEHP`
(Harman Park Arena). The whole site sits behind a **Queue-it** virtual waiting room that is currently in
"after-event" mode — machine-fetchable **only with a cookie jar**:

```
GET  https://register.oshawa.ca/OSHAWA/public/category/browse/SKATEDHC
 302 → https://cityofoshawa.queue-it.net/?c=cityofoshawa&e=2026recfalld2&…&t=<original url>
 302 → /afterevent.aspx?…  (sets Queue-it-visitorsession)
 302 → https://register.oshawa.ca/…/SKATEDHC?queueittoken=e_2026recfalld2~ts_…~rt_afterevent~h_…
 302 → https://register.oshawa.ca/…/SKATEDHC   (sets QueueITAccepted-SDFrts345E-V3_2026recfalld2=…)
 200  (ASP.NET_SessionId, BasketGUID, __RequestVerificationToken)
```
Node's `fetch` fails with "redirect count exceeded" because it drops cookies between hops; `curl -L -c jar -b jar`
works. The fetcher needs a tiny manual redirect loop that stores `Set-Cookie` (the existing `httpGetText` follows 3
redirects but keeps no cookies — extend it). The `e=2026recfalld2` event name will change each registration season;
nothing to hard-code, just follow.

**Best request — one per arena for the whole window (verified, 28 days in one 1.7 MB page):**
```
GET https://register.oshawa.ca/OSHAWA/public/Booking/VenueClasses?GUID=<venueGuid>&StartDate=2026-09-14&EndDate=2026-10-11&Participant=00000000-0000-0000-0000-000000000000
```
Venue GUIDs: Delpark Homes Centre `0c780b98-9e2c-4f79-a226-a6106d010224`; Donevan Recreation Complex
`96bac799-82c0-45ed-b6ab-065a198d48a5`; Harman Park Arena: **not yet published** (its `SKATEHP` category shows no
rows on any sampled date through Dec 5 — ice not in yet; the GUID appears in the first row's
`VenueClasses?GUID=…` link once it is). Per-category `ClassList?CategoryGUID=…&StartDate=…` (DHC
`b0adc41a-fab7-416e-aab1-f150e60913f0`, DRC `9a0dbdfe-6fd5-473f-9eff-c4111ae1d3c0`, HP `3ab59e86-1349-457e-bda2-00ec48a1ba5a`)
returns **one day per request** and ignores `EndDate` — 84 requests for 28 days, so prefer VenueClasses and filter by
activity name (`/skate|shinny|stick|ticket ice/i`; the venue page also lists yoga, badminton, aquafit…).

Server-rendered structure (no JS needed): one `div.card` per date with `<h2>Monday, September 14, 2026</h2>`, then
per-session cards `div.card.mb-4 > .card-header h4 (activity) + card-text "Date:", "Time: 9:15 AM - 10:05 AM (50 mins)",
"Location: DHC - Arena 3 (Owasco)", "Facility: Delpark Homes Centre", "Spaces: 135", "Drop in only"`, plus a single
`<table class="table …">` with rows `<tr class="align-middle"><td>9:15 AM - 10:05 AM<br><span class="d-duration">…</span></td><td>… Parent &amp; Tot Skate</td><td class="d-location">DHC - Arena 3 (Owasco)</td><td class="d-venue">… Delpark Homes Centre</td><td class="d-spaces">135</td><td class="d-availability">Drop in only</td></tr>`
(the table has no date column → parse the cards, which carry the date). "Spaces" = capacity, not availability.

Trimmed sample (Delpark, Mon 2026-09-14):
```
Parent & Tot Skate            | 9:15 AM - 10:05 AM | DHC - Arena 3 (Owasco)          | 135 | Drop in only
Adult Skate                   | 10:15 AM - 11:35 AM| DHC - Arena 3 (Owasco)          | 80  | Drop in only
Public Skate                  | 1:15 PM - 2:35 PM  | DHC - Arena 3 (Owasco)          | 180 | Drop in only
Stick & Puck (7-12 yrs)       | 4:30 PM - 5:20 PM  | DHC - Arena 2 (Freedom Mobile)  | 50  | Drop in only
Women's Shinny Hockey (18+ yrs)| 5:30 PM - 6:20 PM | DHC - Arena 2 (Freedom Mobile)  | 25  | Drop in only
```
28-day Delpark counts: Public Skate 33, Parent & Tot 19, Adult Skate 16, Ticket Ice 8, Stick & Puck 7+7, Shinny
(18+/50+/Women's) 16.

**Prices** (oshawa.ca Memberships & Admissions, 2026): leisure skate daily — Preschooler (≤3) free, Child/Youth $3.50
(10 for $31.53), Student $3.50, Adult $5.25 (10 for $47.29), Family $10.75, Oshawa 55+ $1.50; Shinny Adult $8.50
(10 for $76.48), Youth $6.50, goalie free, 55+ $6.50; Figure Skating/Ticket Ice $11.25.

**Venues** (oshawa.ca addresses; Nominatim):

| Venue | Address | Postal | Lat, Lng | Note |
|---|---|---|---|---|
| Delpark Homes Centre (arena) | 1661 Harmony Rd N | L1H 7K5 | 43.9485033, -78.8512963 | 3 pads; skate rentals (BNC Pro Shop) |
| Donevan Recreation Complex (arena) | 171 Harmony Rd S | L1H 6T9 | 43.8999743, -78.8305996 | |
| Harman Park Arena | 829 Douglas St (per oshawa.ca; not 870 Farewell) | L1H 3S6 (Nominatim) | 43.8786429, -78.8469186 | no fall sessions published yet |
| Children's Arena | 155 Arena St | L1J 4E1 | 43.9004053, -78.8722793 | **not listed** on Leisure Skating page — no public skating |
| Campus Ice Centre | 2010 Simcoe St N | L1L 0R1 | 43.9666821, -78.9044398 | private (Ontario Tech); not on city schedules — would need its own source |
| Tribute Communities Centre | 99 Athol St E | L1H 1J8 | 43.8970124, -78.8591951 | OHL arena; no public skating |

Suggested entry:
```js
'oshawa': {
    kind: 'intelligenz',            // register.oshawa.ca VenueClasses pages (server-rendered HTML, Queue-it cookie gate)
    base: 'https://register.oshawa.ca/OSHAWA',
    venues: [   // VenueClasses?GUID=…  one request per venue covers the whole window
        { guid: '0c780b98-9e2c-4f79-a226-a6106d010224', name: 'Delpark Homes Centre',        address: '1661 Harmony Rd N', postalCode: 'L1H 7K5', lat: 43.9485033, lng: -78.8512963 },
        { guid: '96bac799-82c0-45ed-b6ab-065a198d48a5', name: 'Donevan Recreation Complex',  address: '171 Harmony Rd S',  postalCode: 'L1H 6T9', lat: 43.8999743, lng: -78.8305996 }
        // Harman Park Arena (829 Douglas St, 43.8786429,-78.8469186): add its GUID once fall ice sessions appear
    ],
    activityMatch: /skate|shinny|stick|ticket ice/i,
    prices: [{ match: /shinny/i, price: 8.50 }, { match: /ticket ice/i, price: 11.25 }, { match: /.*/, price: 5.25 }],
    daysAhead: 28, paid: true, district: 'Oshawa',
    registrationUrl: () => 'https://register.oshawa.ca/OSHAWA/public/category/browse/SKATEDHC',
    infoUrl: 'https://www.oshawa.ca/explore-play/recreation/hockey-and-skating/leisure-skating/'
}
```

---

## 7. City of Pickering — HTML tables, free (bonus)

**Platform:** none — `https://www.pickering.ca/parks-recreation-culture/arenas-and-skating/` embeds the schedule as
two plain `<table border="1">` grids ("Fall 2026 Public Skate Schedule", **Admission: FREE**). ActiveNet
(`…/cityofpickering`, "Pickering Active Online") only has Learn-to-Skate lessons (`activities/list` keyword `Skat` →
22 lesson activities, none drop-in) and `rest/onlinecalendar/calendars` answers `response_code 0008 "No license"`.

Structure: table 1 (9 rows) `Chestnut Hill Developments Recreation Complex | FALL | Daytime Skate | Public Skate`
then `Monday | 11:00 am - 1:00 pm | (blank)` … `Saturday | na | 2:45 pm - 4:30 pm`; table 2 (3 rows) `Don Beer Arena |
FALL | Public Skate | P&C Skate | P&C Stick & Puck` then `Sunday | 5:30 pm - 7:30 pm | 2:30 pm - 4:00 pm | 4:00 pm - 5:30 pm`.
Season text above: "Daytime Skating: September 8 - December 18, 2026", "Parent & Child / Stick & Puck: September 13 -
December 20, 2026", "Public Skating: September 8 - December 20, 2026"; cancellation dates listed per program ("CHD Rec
Complex - Oct 10, Nov 7, Dec 5, Dec 12; Don Beer Arena - Nov 8, Dec 6, Dec 13; Daytime: Oct 12, Oct 9, Nov 6, Dec 4,
Dec 11; P&C: Nov 8, Dec 6, Dec 13"). Feasibility: **easy scrape** (tiny, stable page, plain GET, no cookies) — needs a
small weekday-grid parser (row = weekday, column = program) plus the cancellation-date list; the LLM-assist path in
`fetchScraped` would also handle it.

Fall 2026 schedule: CHDRC Daytime Skate Mon–Fri 11:00 am–1:00 pm; Public Skate Tue 6:45–8:30 pm, Sat 2:45–4:30 pm.
Don Beer Public Skate Sun 5:30–7:30 pm; Parent & Child Skate Sun 2:30–4:00 pm; P&C Stick & Puck Sun 4:00–5:30 pm.

| Venue | Address | Postal | Lat, Lng | Rinks |
|---|---|---|---|---|
| Chestnut Hill Developments Recreation Complex (arena entrance on Diefenbaker Ct) | 1867 Valley Farm Rd | L1V 3Y7 | 43.8392345, -79.0814572 | Delaney, O'Brien |
| Don Beer Arena | 940 Dillingham Rd | L1W 1Z6 | 43.8246758, -79.0671679 (street match) | DB1, DB2, DB3 |

Suggested entry: `kind: 'scrape-grid'` (new) `{ url: 'https://www.pickering.ca/parks-recreation-culture/arenas-and-skating/', paid: false, unverified: true, venues: { 'Chestnut Hill Developments Recreation Complex': {…}, 'Don Beer Arena': {…} }, district: 'Pickering' }`.

---

## Appendix A — generic ActiveNet cookbook (works on richmondhill, townofws, ajax; Pickering lacks the calendar licence)

```
GET  /<org>/rest/onlinecalendar/calendars?locale=en-US                         → body.calendars[{calendar_id, name}]
POST /<org>/rest/onlinecalendar/filters?locale=en-US   {"calendar_id":N}       → center[], activity[], facilities[], calendar_period
POST /<org>/rest/onlinecalendar/multicenter/events?locale=en-US  {"calendar_id":N,"center_ids":[…]}  → center_events[].events[]
GET  /<org>/rest/onlinecalendar/centerdetails?center_ids=1,2,3&locale=en-US   → names, address1, zip_code, hours
POST /<org>/rest/activities/list?locale=en-US  (header page_info, body activity_search_pattern)      → activity_items[]
GET  /<org>/rest/activity/detail/<id>?locale=en-US                             → season, dates, facilities, ages
GET  /<org>/rest/activity/detail/meetingandregistrationdates/<id>?locale=en-US → activity_patterns / exception_dates
```
All JSON, `Content-Type: application/json;charset=utf-8`, no auth/cookies; UA `toronto-skating-site-data-fetcher` accepted.
`display_all` must be an integer (0 all, 1 activities only, 2 facility events only); booleans → HTTP 500.

## Appendix B — scratch files (this directory)

`pm.js`, `pmall.js` (PerfectMind probe + verified paging loop), `pmcats.js` (widget → calendars), `an.js` (ActiveNet
activities/list), `nom.sh` (Nominatim), raw responses: `pm-cityofmarkham…json`, `vaughan-classes-v2.json`,
`vaughan-p1..4.json`, `events-richmondhill.json`, `rh-dates-146253.json`, `rh-activity-146253.json`,
`ws-skating-f26.pdf/.txt`, `ajax-fall2026.pdf/.txt`, `oshawa-venue-rng.html` (28-day Delpark page), `markham-fees.txt`.
