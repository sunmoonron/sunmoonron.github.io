# Canlan Sports (DaySmart Recreation) — GTA facility research

Research date: 2026-09-14 (Toronto). Event window checked: **2026-09-14 → 2026-10-12** (28 days, same as `daysAhead: 28`).
Every endpoint below was hit with real `curl`/Node `fetch` requests (`Accept: application/vnd.api+json`, no auth) and returned HTTP 200 unless stated otherwise. Raw responses are saved in this scratchpad (`facilities.json`, `resources*.json`, `events_fac*.json`, `samples.json`, `geocode.json`).

---

## 1. TL;DR

- Company slug `canlan` exposes **23 facilities**; the Ontario ones are **3 Etobicoke (CWENCH Centre), 5 York (NFP Athletic Centre), 13 Oakville (Entripy Centre), 14 Oshawa, 15 Scarborough**, plus **16 Mississauga** (`active:false`, no ice — only a ball-hockey rink/turf/courts), **20 Victoria Park** (`active:false`, zero resources, legacy icesports.com record) and **6 "CCT (Tournaments)"** (virtual tournament facility, 0 events). canlansports.com/locations lists exactly the five real ones.
- Public skating in the next 28 days: **Etobicoke 20**, **York 13**, **Scarborough 21**, **Oakville 2 Public Skating + 6 Senior Skate (55+)**, **Oshawa 0** (Stick & Puck / Shinny / classes only). Every public skate is product `1053 "Public Skating - Tier 1"` at **$5** (`actual_price`); Oakville Senior Skate is product `274 "Public Skate Drop-In (Sr.)"` at **$0**.
- **Bug 1 (fetcher):** at Scarborough **17 of 21** public skates have an **empty `desc`** — the name is only in `summary.name` / `homeTeam.name`. The current `/public\s*skat/i` test on `a.desc` would find 4 of 21. Match on `desc || summary.name || team.name`.
- **Bug 2 (fetcher):** Oakville returns **287 events / 28 days**, more than `page[size]=200`, and the fetcher does not follow `links.next`. Fix: add `filter[event_type_id]=56` (Drop-In; cuts Oakville to 71) and/or `page[size]=500` (verified honoured) or paginate.
- **"-1 spots left" root cause:** `summary.open_slots = min(non-negative of remaining_registration_slots, remaining_roster_slots)`, and **-1 when neither is set** (verified on all 753 summaries). York's Public Skate events have `register_capacity: 0` → `composite_capacity: 0`, `open_slots: -1` = **uncapped**, not "over-booked". The client renders it because `-1 != null` and `capacity 0` is falsy. Rule: treat `open_slots < 0` or `composite_capacity <= 0` as "no cap" and show no number. Also `registration_status` has values `open | closed | full | upcoming | null`; the client currently labels `full` and `upcoming` as "Registration closed".
- CORS verified from Node with `Origin: https://sunmoonron.github.io` → `access-control-allow-origin: https://sunmoonron.github.io`, preflight 204 with `accept` allowed. The in-browser live fetch is legitimate.

---

## 2. Facility table (company `canlan`, Ontario)

Source of ids/addresses: `GET /v1/facilities?company=canlan&include=address` and `GET /v1/resources?company=canlan&filter[type_id]=2&include=facility` (resource type 2 = "Rink"). Coordinates: DaySmart's own `lat/lng` vs Nominatim house-level geocode of the DaySmart street address (User-Agent sent, 1.2 s spacing).

| fac id | DaySmart name | active | Ice-rink resource ids (type_id 2) | Street address (DaySmart address record) | Postal (DaySmart / OSM) | DaySmart lat,lng | Nominatim lat,lng | Δ | Skate events in window |
|---|---|---|---|---|---|---|---|---|---|
| **3** | CWENCH Centre (Etobicoke) | true | **207** Rink 1, **208** Rink 2, **209** Rink 3, **210** Rink 4 | 1120 Martin Grove Rd, Etobicoke ON | M9W 4W1 / M9W 4W4 | 43.699755, -79.578308 | 43.7002961, -79.5750312 | 0.27 km | **20 × "Public Skating"** ($5, cap 100) |
| **5** | NFP Athletic Centre (York) | true | **3,4,5,6,7,8** Rink 1–6 | 989 Murray Ross Pkwy, North York ON | M3J 3M4 / M3J 2P3 | 43.7747279, -79.5137961 | 43.7761606, -79.5167380 | 0.28 km | **13 × "Public Skate"** ($5, **uncapped**) |
| **13** | Entripy Centre - Oakville | true | **104** Rink 1, **102** Rink 2, **103** Rink 3, **105** Rink 4 | 2300 Cornwall Rd, Oakville ON | L6J 7T9 / L6J 7Z6 | 43.4884604, -79.6485878 | 43.4882179, -79.6501451 | 0.13 km | **2 × "Public Skating"** ($5, cap 100, both in Oct) + **6 × "Senior Skate"** ($0, 55+, cap 100) |
| **14** | Oshawa | true | **54** Rink 1, **65** Rink 2 | 1401 Phillip Murray Ave, Oshawa ON | L1J 8C4 / L1N 7G4 | 43.853695, -78.8791328 | 43.8546816, -78.8809418 | 0.18 km | **0** public/adult/family skate (33 Drop-In events: Stick & Puck, Shinny) |
| **15** | Scarborough | true | **440** Rink 1, **441** Rink 2, **442** Rink 3, **443** Rink 4 | 159 Dynamic Dr, Scarborough ON | M1V 5L8 / M1V 5G4 | 43.8055913, -79.4083341 **(wrong)** | **43.8284798, -79.2524897** | **12.76 km** | **21 × "Public Skating"** ($5, cap 200) — 17 have empty `desc` |
| 16 | Mississauga | **false** | none (128 "Rink 1" is type 8 = Ball Hockey Rink; fields/courts only) | 3360 Wolfedale Rd, Mississauga ON | L5C 1W4 | 43.5680635, -79.6492456 | 43.5673996, -79.6424801 | 0.55 km | 0 events — **not an ice facility; skip** |
| 20 | Victoria Park | **false** | none (0 resources) | 3552 Victoria Park Ave, North York ON | M2H 2N5 | 43.8056128, -79.340306 | 43.8057400, -79.3382100 | 0.17 km | 0 — **defunct record (tz America/New_York, icesports.com email); skip** |
| 6 | CCT (Tournaments) | true | 486 Youth Ice, 487 Adult Ice (virtual) | 989 Murray Ross Pkwy (same as York) | M3J 3P1 | = York | — | — | 0 events — **tournament pseudo-facility; skip** |

Notes
- DaySmart's Scarborough coordinate points near Bayview/Steeles, 12.8 km from 159 Dynamic Dr (Milliken, Steeles E & Markham Rd). A second structured Nominatim query returned 43.8297869, -79.2532673 (same block). Use the Nominatim value.
- Postal codes: DaySmart's are the venue-published ones (match canlansports.com); OSM's differ because the building footprint node carries a neighbouring code. Keep DaySmart's.
- All five real facilities have `tz: "America/Toronto"`; event `start`/`end` are naive facility-local, `start_gmt`/`end_gmt` are UTC, and `summary.start_date` carries the `-04:00` offset.
- York rinks: a public skate ran on Rink 3 (id 5) on 09-29 and Rink 1 (id 3) on 09-29 — keep all six ids.
- Other Canlan facilities (all non-GTA, listed for completeness): 1 Scotia Barn (Burnaby), 2 Langley, 8 North Shore, 9 Armstrong, 10 South Cariboo, 11 Winnipeg, 12/19 Saskatoon South/North, 4 West Dundee, 17/23 Romeoville, 18 Lake Barrington, 21 Libertyville, 7 CCT Hockey - Seattle, 22 Stripe Test.

---

## 3. Verified endpoints and working request URLs

Base: `https://api.daysmartrecreation.com/v1` (JSON:API; `links.first/next/last` point at `/api/v1/...` which is the same service). All requests: `-H 'Accept: application/vnd.api+json'`, query param `company=canlan`. No auth, no cookies.

### 3.1 Discovery endpoints

| Purpose | URL (verified 200) | Notes |
|---|---|---|
| Facilities + street addresses | `https://api.daysmartrecreation.com/v1/facilities?company=canlan&include=address&page%5Bsize%5D=200` | 23 facilities; `attributes`: name, phone, email, facilityWww, tz, active, lat, lng. `relationships.address.data.id` → included `addresses` (address_line1, locality, administrative_area, postal_code, country). |
| **Rink → facility mapping** | `https://api.daysmartrecreation.com/v1/resources?company=canlan&filter%5Btype_id%5D=2&include=facility&page%5Bsize%5D=200` | 56 rink resources company-wide; `attributes.facility_id`, `attributes.name`, `type_id`; included `facilities`. This is the mapping the task asked for. |
| Rinks of one facility | `https://api.daysmartrecreation.com/v1/resources?company=canlan&filter%5Bfacility_id%5D=3&filter%5Btype_id%5D=2&page%5Bsize%5D=50` | `filter[facility_id]` **works on /resources** (unlike /events). Returns 207,208,209,210 for Etobicoke. |
| All resources (paged) | `https://api.daysmartrecreation.com/v1/resources?company=canlan&page%5Bsize%5D=500&page%5Bnumber%5D=2` | 771 total, `page[size]=500` honoured. |
| Resource types | `https://api.daysmartrecreation.com/v1/resource-types?company=canlan&page%5Bsize%5D=200` | 1 Locker Room, **2 Rink**, 4 Room Rental, 5 Lease Space, 6 Court, 7 Field, 8 Ball Hockey Rink, 9 Climbing Wall, 10 Parking Lot, 11 Game Deck, 19 Vendor Rental. |
| Event types | `https://api.daysmartrecreation.com/v1/event-types?company=canlan&page%5Bsize%5D=200` | 71 types. **56 = "Drop-In"** (all public/senior skates, stick & puck, shinny). `c` = Class, `k` = Camp, `g` = Game, `r` = Rental. |
| Programs (the `program_types=` ids in the registration SPA URL) | `https://api.daysmartrecreation.com/v1/programs?company=canlan&page%5Bsize%5D=200` | **51 Public Skating**, 54 Senior Skate, 72 Holiday Skate, 79 DJ Public Skating, 50 Stick & Puck, 74 Family Stick & Puck, 49 Shinny, 14 Drop-In. Confirms `program_types=51` in the existing `registrationUrl`. |

### 3.2 Events endpoint — what the fetcher uses today (verified)

```
https://api.daysmartrecreation.com/v1/events?cache%5Bsave%5D=false
  &filter%5Bresource_id__in%5D=3,4,5,6,7,8
  &filter%5Bstart_date__gte%5D=2026-09-14&filter%5Bstart_date__lte%5D=2026-10-12
  &filter%5Bpublish%5D=1&page%5Bsize%5D=200&sort=start
  &include=homeTeam.product&company=canlan
```
Returns `data[]` events (`attributes.desc, resource_id, event_type_id, start, end, start_gmt, end_gmt, publish, register_capacity, hteam_id, …`) and `included[]` of `teams` (`product_id`, `name`, `facility_id`) and `products` (`price`, `actual_price`, `local_price`, `non_resident_price`). Per-facility totals in the window with this exact shape: Etobicoke 175, York 33, **Oakville 287 (2 pages!)**, Oshawa 72, Scarborough 186.

### 3.3 Events endpoint — recommended shape (verified per facility)

```
https://api.daysmartrecreation.com/v1/events?cache%5Bsave%5D=false
  &filter%5Bresource_id__in%5D=207,208,209,210
  &filter%5Bevent_type_id%5D=56
  &filter%5Bstart_date__gte%5D=2026-09-14&filter%5Bstart_date__lte%5D=2026-10-12
  &filter%5Bpublish%5D=1&page%5Bsize%5D=500&sort=start
  &include=homeTeam.product,summary&company=canlan
```
Swap the resource list per facility: York `3,4,5,6,7,8` · Etobicoke `207,208,209,210` · Oakville `102,103,104,105` · Oshawa `54,65` · Scarborough `440,441,442,443`.
Results with `event_type_id=56` (all single page): Etobicoke 59 (20 public skates), York 29 (13), Oakville 71 (2 + 6 senior), Oshawa 33 (0), Scarborough 92 (21). `include=summary` adds one `event-summaries` object per event (same id as the event) with `name`, `registration_status`, `open_slots`, `composite_capacity`, `registered_count`, … — this is what `live.js` already reads.

### 3.4 Live spots query used by `skate/projects/js/live.js` (verified)

```
https://api.daysmartrecreation.com/v1/events?cache%5Bsave%5D=false&filter%5Bid__in%5D=4793284,4793285,…&include=summary&page%5Bsize%5D=13&company=canlan
```
200, 13 events + 13 `event-summaries`. Response headers with `Origin: https://sunmoonron.github.io`: `access-control-allow-origin: https://sunmoonron.github.io`, `access-control-allow-credentials: true`, `vary: Origin`, `cache-control: no-cache, private`. `OPTIONS` preflight: 204, `access-control-allow-headers: accept`, methods `POST, GET, OPTIONS, PATCH, PUT, DELETE`.

### 3.5 Filter / include behaviour matrix (events endpoint, Oakville rinks, same window)

| Query | Result | Verdict |
|---|---|---|
| `filter[resource_id__in]=102,103,104,105` | total 287 | works (the baseline) |
| `+ filter[event_type_id]=56` | total 71 | **works** — recommended |
| `+ filter[event_type_id__in]=56,11` | total 71 | works |
| `filter[facility_id]=13` | total 2929 | **silently ignored** (= all company events) |
| `filter[facility_ids]=13` | total 2929 | **silently ignored** (confirms the code comment) |
| `filter[resource.facility_id]=13` | total 288 | works (287 rink events + 1 on a non-rink resource) — usable fallback |
| `filter[resource.facility_id]=15&filter[event_type_id]=56` | total 111 | works |
| `+ filter[desc__like]=%Skat%` | total 143 | honoured but useless (matches "Learn to Skate", misses empty `desc`) |
| `+ filter[hteam.program_id]=51` | total 287 | ignored |
| `page[size]=500` / `page[size]=1000` | per-page echoed 500 / 1000, 287 rows on one page | **honoured** |
| `include=eventType` | 200, included `event-types` | works |
| `include=resource,facility` | **HTTP 500** | do not use |
| `include=summary` | 200 | works (also on `filter[id__in]` queries) |

---

## 4. Trimmed sample event JSON per facility

Each sample = one `data[]` event + its `event-summaries` include + `teams` + `products` (fields trimmed to the ones that matter). Full copies in `samples.json`.

### Etobicoke (fac 3) — event 5387053, Rink 1
```json
{
  "event":   { "id": "5387053", "resource_id": 207, "desc": "Public Skating", "event_type_id": "56",
               "start": "2026-09-14T12:15:00", "end": "2026-09-14T13:05:00", "start_gmt": "2026-09-14T16:15:00",
               "publish": true, "register_capacity": 100, "hteam_id": 77050 },
  "summary": { "name": "Public Skating", "event_type": "Drop-In",
               "start_date": "2026-09-14T12:15:00-04:00", "end_date": "2026-09-14T13:05:00-04:00",
               "registration_status": "open", "registered_count": 4, "team_registered_count": 282,
               "remaining_registration_slots": 96, "remaining_roster_slots": -1, "open_slots": 96, "composite_capacity": 100 },
  "team":    { "id": "77050", "name": "Public Skating", "facility_id": 3, "product_id": 1053, "max_roster_size": null },
  "product": { "id": "1053", "name": "Public Skating - Tier 1", "price": 5, "actual_price": 5, "local_price": 5, "non_resident_price": 5 }
}
```

### York (fac 5) — event 4793284, Rink 5 — the "-1 spots" case
```json
{
  "event":   { "id": "4793284", "resource_id": 7, "desc": "Public Skate", "event_type_id": "56",
               "start": "2026-09-14T13:15:00", "end": "2026-09-14T14:35:00", "start_gmt": "2026-09-14T17:15:00",
               "publish": true, "register_capacity": 0, "hteam_id": 77261 },
  "summary": { "name": "Public Skate", "event_type": "Drop-In",
               "start_date": "2026-09-14T13:15:00-04:00", "end_date": "2026-09-14T14:35:00-04:00",
               "registration_status": "open", "registered_count": 2, "team_registered_count": 144,
               "remaining_registration_slots": -1, "remaining_roster_slots": -1, "open_slots": -1, "composite_capacity": 0 },
  "team":    { "id": "77261", "name": "Public Skating", "facility_id": 5, "product_id": 1053, "max_roster_size": null },
  "product": { "id": "1053", "name": "Public Skating - Tier 1", "price": 5, "actual_price": 5, "local_price": 5, "non_resident_price": 5 }
}
```

### Oakville (fac 13) — event 5679767, Rink 4 — Senior Skate (already started when fetched → `closed`)
```json
{
  "event":   { "id": "5679767", "resource_id": 105, "desc": "Senior Skate", "event_type_id": "56",
               "start": "2026-09-14T08:45:00", "end": "2026-09-14T10:20:00", "start_gmt": "2026-09-14T12:45:00",
               "publish": true, "register_capacity": 100, "hteam_id": 91641 },
  "summary": { "name": "Senior Skate", "event_type": "Drop-In",
               "start_date": "2026-09-14T08:45:00-04:00", "end_date": "2026-09-14T10:20:00-04:00",
               "registration_status": "closed", "registered_count": 3, "team_registered_count": 5,
               "remaining_registration_slots": 97, "remaining_roster_slots": -1, "open_slots": 97, "composite_capacity": 100 },
  "team":    { "id": "91641", "name": "Senior Skate (September 2026)", "facility_id": 13, "product_id": 274, "max_roster_size": null },
  "product": { "id": "274", "name": "Public Skate Drop-In (Sr.)", "price": 0, "actual_price": 0, "local_price": 0, "non_resident_price": 0 }
}
```
Oakville "Public Skating" (events 5613027 on 2026-10-09 14:15 and 5619xxx on 2026-10-12 13:00) has the same shape as Etobicoke: `register_capacity: 100`, product 1053 $5, team "Public Skating (October 2026)".

### Oshawa (fac 14) — event 5617786, Rink 2 — no skate sessions in window; Stick & Puck shown for shape
```json
{
  "event":   { "id": "5617786", "resource_id": 65, "desc": "Stick & Puck", "event_type_id": "56",
               "start": "2026-09-14T07:30:00", "end": "2026-09-14T08:20:00", "start_gmt": "2026-09-14T11:30:00",
               "publish": true, "register_capacity": 25, "hteam_id": 91094 },
  "summary": { "name": "Stick & Puck", "event_type": "Drop-In", "registration_status": "closed",
               "registered_count": 8, "team_registered_count": 136,
               "remaining_registration_slots": 17, "remaining_roster_slots": -1, "open_slots": 17, "composite_capacity": 25 },
  "team":    { "id": "91094", "name": "Stick & Puck", "facility_id": 14, "product_id": 1048, "max_roster_size": null },
  "product": { "id": "1048", "name": "Stick & Puck - Tier 1", "price": 10, "actual_price": 10, "local_price": 10, "non_resident_price": 10 }
}
```

### Scarborough (fac 15) — event 5685172, Rink 1 — note the EMPTY `desc`
```json
{
  "event":   { "id": "5685172", "resource_id": 440, "desc": "", "event_type_id": "56",
               "start": "2026-09-14T11:15:00", "end": "2026-09-14T12:05:00", "start_gmt": "2026-09-14T15:15:00",
               "publish": true, "register_capacity": 200, "hteam_id": 82232 },
  "summary": { "name": "Public Skating", "event_type": "Drop-In",
               "start_date": "2026-09-14T11:15:00-04:00", "end_date": "2026-09-14T12:05:00-04:00",
               "registration_status": "open", "registered_count": 1, "team_registered_count": 107,
               "remaining_registration_slots": 199, "remaining_roster_slots": -1, "open_slots": 199, "composite_capacity": 200 },
  "team":    { "id": "82232", "name": "Public Skating", "facility_id": 15, "product_id": 1053, "max_roster_size": null },
  "product": { "id": "1053", "name": "Public Skating - Tier 1", "price": 5, "actual_price": 5, "local_price": 5, "non_resident_price": 5 }
}
```

---

## 5. "Spots left" analysis

Dataset: 753 `event-summaries` across the five facilities (all published events in the window, not just skates).

### 5.1 Field semantics (empirically derived)

| Field | Where | Meaning observed |
|---|---|---|
| `event.register_capacity` | event attributes | Per-event registration cap as configured by the venue. **0 = no cap set.** |
| `summary.remaining_registration_slots` | summary | `register_capacity − registered_count` when a cap exists; **-1 when `register_capacity` is 0**. |
| `summary.remaining_roster_slots` | summary | Team-roster based remaining (classes/camps with `max_roster_size`); **-1 when no roster limit**. Drop-ins always -1. |
| `summary.open_slots` | summary | **`= min(non-negative values of remaining_registration_slots, remaining_roster_slots)`, else -1.** Held for **753/753** summaries. |
| `summary.composite_capacity` | summary | The binding cap (registration cap, roster cap, or min of both when both exist, e.g. `register_capacity 3` + roster 2 → 2). **0 when no cap of any kind.** |
| `summary.registered_count` | summary | Registrations on this event. |
| `summary.team_registered_count` | summary | Registrations across the whole team/season — not per session; ignore. |
| `summary.registration_status` | summary | `open` (719), `upcoming` (15), `full` (10), `closed` (5), `null` (4). |

### 5.2 Which combinations produce a negative number

| Combination | Count | Meaning | Example |
|---|---|---|---|
| `register_capacity 0` → `composite_capacity 0`, `remaining_registration_slots -1`, `remaining_roster_slots -1`, **`open_slots -1`** | 33 (23 status open, 6 upcoming, 4 null) | **Uncapped / capacity not configured** — this is every York Public Skate and York Stick & Puck. It is *not* registrations exceeding capacity. | York 4793284 |
| `composite_capacity > 0` with `open_slots < 0` | **0** | never observed — registrations never exceed capacity in the data | — |
| `open_slots = 0` with `status = full` | 10 | legitimately full (all 2-goalie clinics and a private class, `composite_capacity 2`) | Etobicoke 5648888 |
| `open_slots < -1` | **0** | never observed | — |
| `open_slots > composite_capacity` | **0** | never observed | — |

So the only negative value the API ever emits is the sentinel **-1 = unlimited/unset**; `composite_capacity` is 0 at the same time. `live.js` maps `open: a.open_slots ?? …` → `-1`, `capacity: a.composite_capacity` → `0`; `app.js` line 563 then renders `${live.open}${live.capacity ? '/'+live.capacity : ''} spots left` → **"-1 spots left"**, and `live.open <= 20` also gives it the `low` class.

### 5.3 `registration_status` vs the client's labelling

- `closed` was only seen on events whose start time had already passed (day-of, -0.1 to -0.2 days) — i.e. registration closes at start time.
- `upcoming` = registration window not open yet (York Public Skate 4797786 on 10-05, York Stick & Puck in October, Oshawa Skills & Drills 2–16 days out). `app.js` line 560 shows **"Registration closed"** for any status `!== 'open'` before the session ends, which mislabels `upcoming` (and `full`).
- `null` = events with no home team (`has_home_team: false`, e.g. York "Takedown - Stick & Puck") — not registerable online; show nothing.

### 5.4 Recommended rule

`live.js` normalisation (replace the three lines in the `event-summaries` loop):
```js
const a = inc.attributes || {};
const cap  = (typeof a.composite_capacity === 'number' && a.composite_capacity > 0) ? a.composite_capacity : null;
const open = (typeof a.open_slots === 'number' && a.open_slots >= 0) ? a.open_slots : null;   // -1 = uncapped → null
byId[String(inc.id)] = {
    open,                       // number ≥ 0, or null when the venue set no cap
    capacity: cap,              // number > 0, or null
    registered: a.registered_count ?? null,
    status: a.registration_status || null   // 'open' | 'upcoming' | 'full' | 'closed' | null
};
```
`app.js` badge logic:
```js
if (live) {
    if (live.status === 'full') {
        spotsBadge = '<span class="spots-badge closed-reg" title="Sold out online">Full</span>';
    } else if (live.status === 'upcoming') {
        spotsBadge = '<span class="spots-badge" title="Online registration has not opened yet">Registration opens later</span>';
    } else if (live.status === 'closed' && st.phase !== 'ended') {
        spotsBadge = '<span class="spots-badge closed-reg" title="The venue\'s online registration for this session is closed">Registration closed</span>';
    } else if (live.status === 'open' && live.open != null) {
        spotsBadge = `<span class="spots-badge${live.open <= 20 ? ' low' : ''}" title="Live from the venue's registration system">${live.open}${live.capacity ? '/' + live.capacity : ''} spots left</span>`;
    }
    // live.open == null (uncapped, e.g. every York public skate): render no number.
    // Optional: `<span class="spots-badge" title="No capacity limit set by the venue">Open registration</span>`.
}
```
Sanity: with this rule Etobicoke shows e.g. "96/100 spots left", Scarborough "199/200", Oakville "97/100", York shows no count (or "Open registration"), never "-1".

---

## 6. Fetcher issues found in `fetch-skate-data.js` `fetchDaySmart()` (read-only findings, not applied)

1. **Empty `desc` (Scarborough).** 85 of Scarborough's 186 events have `desc: ""`; among public skates 17/21. The name is in `included event-summaries[id].attributes.name` and in `teams[hteam_id].name` ("Public Skating"). Since `homeTeam` is already included, the minimal fix needs no new include: `const label = (a.desc || '').trim() || teams[a.hteam_id]?.name || '';` then `rule.match.test(label)`. Adding `,summary` to `include` and preferring `summary.name` is cleaner (it is the display name DaySmart itself shows).
2. **Truncation at 200.** Oakville: 287 events in 28 days; `links.next` is not followed. Use `filter[event_type_id]=56` (public/senior skates are all Drop-In; classes/camps/rentals drop out) and/or `page[size]=500`; both verified. Even better, loop while `json.links.next`.
3. **Price** is fine: `products[team.product_id].actual_price` = 5 at all four facilities (`has_location_pricing: true`, `local_price` identical). Senior Skate product price is 0 → `priceForTeam` returns null → falls back to `rule.defaultPrice` (set it to 0 for that rule).
4. **Static capacity** is available at fetch time: `a.register_capacity` (0 = uncapped). Could be written to each record (e.g. `Capacity`) so the client can say "uncapped" without a live fetch.
5. **Facility filter** for a future refactor: `filter[resource.facility_id]=<id>` works; `filter[facility_id]`/`filter[facility_ids]` do not (silently return every company event).

---

## 7. Paste-ready `EXTERNAL_SOURCES` entries

Same shape as `canlan-york`. `registrationUrl`/`infoUrl` follow the verified-working pattern of the existing entry (SPA hash route — cannot be verified with curl; only `facility_ids` and `program_types` values are substituted, and both ids come from the verified `/facilities` and `/programs` responses). Coordinates are Nominatim house-level results (DaySmart's Scarborough coordinate is 12.8 km off). `district` uses the municipality/borough name, matching the existing convention (`canlan-york` → `'North York'`, the `markham` venues → `'Markham'`).

```js
    'canlan-etobicoke': {
        kind: 'daysmart',
        company: 'canlan',
        // Rinks 1-4 at CWENCH Centre (Etobicoke) — facility_id 3.
        // (filter[facility_ids] is silently ignored by their API, so we
        //  filter by the ice-rink resource ids instead.)
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
        // Rinks 1-4 at Canlan Sports Scarborough — facility_id 15.
        // NOTE: most public skates here have an EMPTY event `desc`; the
        // name only appears in the summary/homeTeam name (see research).
        resourceIds: [440, 441, 442, 443],
        daysAhead: 28,
        programs: [
            { match: /public\s*skat/i, activity: 'Public Skate', defaultPrice: 5 }
        ],
        locationName: 'Canlan Sports Scarborough',
        address: '159 Dynamic Dr',
        district: 'Scarborough',
        postalCode: 'M1V 5L8',
        lat: 43.8284798, lng: -79.2524897,
        paid: true,
        registrationUrl: (date) => `https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?date=${date}&facility_ids=15&program_types=51`,
        infoUrl: 'https://apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?facility_ids=15&program_types=51'
    },
    'canlan-oakville': {
        kind: 'daysmart',
        company: 'canlan',
        // Rinks 1-4 at Entripy Centre (Oakville) — facility_id 13.
        // Rink 1 = 104, Rink 2 = 102, Rink 3 = 103, Rink 4 = 105.
        // Busiest Canlan calendar (287 events / 28 days): needs
        // filter[event_type_id]=56 or page[size]=500 / pagination.
        resourceIds: [102, 103, 104, 105],
        daysAhead: 28,
        programs: [
            { match: /public\s*skat/i, activity: 'Public Skate', defaultPrice: 5 },
            // 55+ drop-in; DaySmart product "Public Skate Drop-In (Sr.)" is listed at $0.00
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
        // Rinks 1-2 at Canlan Sports Oshawa — facility_id 14.
        // No public skate published for 2026-09-14..10-12 (Stick & Puck /
        // Shinny / classes only) — entry yields 0 records until they add one.
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
```

Companion change in `skate/projects/js/live.js` (the client only fetches live spots for keys listed here):
```js
    const SOURCES = {
        'canlan-york':        { company: 'canlan' },
        'canlan-etobicoke':   { company: 'canlan' },
        'canlan-scarborough': { company: 'canlan' },
        'canlan-oakville':    { company: 'canlan' },
        'canlan-oshawa':      { company: 'canlan' }
    };
```
(Each source is batched separately, 60-id cap per source — fine: max 21 sessions/28 days per facility today.)

Suggested `fetchDaySmart` URL/label changes to make the Scarborough and Oakville entries work correctly:
```js
    const url = `https://api.daysmartrecreation.com/v1/events?cache%5Bsave%5D=false` +
        `&filter%5Bresource_id__in%5D=${cfg.resourceIds.join(',')}` +
        `&filter%5Bevent_type_id%5D=56` +                                   // Drop-In only (verified)
        `&filter%5Bstart_date__gte%5D=${start}&filter%5Bstart_date__lte%5D=${end}` +
        `&filter%5Bpublish%5D=1&page%5Bsize%5D=500&sort=start` +            // 500 verified honoured
        `&include=homeTeam.product,summary&company=${cfg.company}`;
    …
    const summaries = {};
    (json.included || []).forEach(i => { if (i.type === 'event-summaries') summaries[i.id] = i.attributes; });
    …
    const label = (a.desc || '').trim() || summaries[e.id]?.name || teams[a.hteam_id]?.name || '';
    const rule = cfg.programs.find(r => r.match.test(label));
```

---

## 8. Caveats / not verified

- The `apps.daysmartrecreation.com/dash/x/#/online/canlan/event-registration?…` links are a single-page-app hash route; only the pattern (already in production for York) and the substituted ids are verified. Whether `program_types=51,54` (comma list) works for Oakville's Senior Skate was not tested.
- Oakville Senior Skate is listed at $0.00 in DaySmart (product 274); whether a fee is collected at the door was not checked.
- Oshawa: zero public skates in this 28-day window; the entry is harmless (0 records) but will show nothing until Canlan publishes one.
- Events were only checked with `filter[publish]=1` (unpublished events are not bookable anyway).
- Nominatim postal codes differ from DaySmart's for every facility (OSM building nodes carry neighbouring codes); DaySmart's match the venue's published addresses and were kept.
