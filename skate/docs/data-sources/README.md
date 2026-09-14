# Data-source research (2026-09-14)

Verified notes behind the venue feeds in `fetch-skate-data.js` — every
endpoint here was executed and answered on the date above. Keep them: they
hold the ids, quirks, prices and venue coordinates that the code only
summarizes, plus the cities that were researched but not wired.

| File | Covers | Wired? |
|---|---|---|
| `canlan-daysmart.md` | Canlan Sports York / Etobicoke / Scarborough / Oakville / Oshawa (DaySmart API), the `open_slots = -1` semantics | yes |
| `peel-halton.md` | Mississauga (ActiveNet), Brampton, Oakville, Burlington (PerfectMind) and the `ClassesV2` truncation behaviour | yes |
| `york-durham.md` | Markham corrections, Vaughan (PerfectMind), Richmond Hill (ActiveNet), Whitchurch-Stouffville, Ajax, Oshawa, Pickering | Markham, Vaughan, Richmond Hill (Ed Sackfield) |

Not wired yet and why: Ajax and Whitchurch-Stouffville publish PDFs only;
Oshawa's booking site sits behind a Queue-it cookie gate; Pickering is a
plain HTML weekday grid (free skates — a small grid parser would do);
Richmond Hill's Tom Graham / Bond Lake / Elgin Barrow drop-ins exist only
as ActiveNet weekly activity patterns (`activities/list` +
`meetingandregistrationdates/{id}`), not calendar rows.
