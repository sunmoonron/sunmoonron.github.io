# Data-source research (2026-09-14)

Verified notes behind the venue feeds in `fetch-skate-data.js` — every
endpoint here was executed and answered on the date above. Keep them: they
hold the ids, quirks, prices and venue coordinates that the code only
summarizes, plus the cities that were researched but not wired.

| File | Covers | Wired? |
|---|---|---|
| `canlan-daysmart.md` | Canlan Sports York / Etobicoke / Scarborough / Oakville / Oshawa (DaySmart API), the `open_slots = -1` semantics | yes |
| `peel-halton.md` | Mississauga (ActiveNet), Brampton, Oakville, Burlington (PerfectMind) and the `ClassesV2` truncation behaviour | yes |
| `york-durham.md` | Markham corrections, Vaughan (PerfectMind), Richmond Hill (ActiveNet), Whitchurch-Stouffville (PDF), Ajax (Publitas PDF), Oshawa (Intelligenz behind Queue-it), Pickering (HTML grid) | all but Richmond Hill's other three arenas |

Wired later the same day (kinds `pdf`, `intelligenz`, `html-grid` in
`fetch-skate-data.js`): Whitchurch-Stouffville's drop-in PDF (weekday grid,
`pdftotext -layout`, discovered from the drop-in page; its empty ActiveNet
calendar is checked first), Ajax's Publitas flipbook PDF (weekday lines with
"Unavailable" dates), Oshawa's VenueClasses pages (cookie-jar redirect loop
through Queue-it, one page per arena) and Pickering's tables (season dates
and cancellation list from the surrounding text).

Still not wired: Richmond Hill's Tom Graham / Bond Lake / Elgin Barrow
drop-ins exist only as ActiveNet weekly activity patterns
(`activities/list` + `meetingandregistrationdates/{id}`), not calendar
rows; Oshawa's Harman Park Arena had no fall ice published (add its GUID to
the `oshawa` entry when category SKATEHP shows rows).
