# Smoke suite

Browser tests for the Toronto Skating app, run with Playwright against the same
static server the dev preview uses, plus a `unit` project that checks the alert
logic in plain Node. Everything is hermetic:

- **Data** comes from `fixtures.js` (`buildData()`): a dozen synthetic sessions
  around a frozen clock (Saturday 2026-10-24, 1 pm Toronto) covering an ended
  session, one on now, a likely-cancelled one, warning / ended / long-ended
  alerts, a dropped-by-the-City session, a paid PickupHub row with live spots,
  an unverified arena with rentals, a Mississauga rink. Both data origins
  (home server and committed copies) are answered from it.
- **Network**: weather, map tiles and the home server's other files are
  aborted; the geocoders answer a fixed M1J; every relay is a mocked WebSocket
  (EOSE to each REQ, OK to each EVENT), so chat tests send, settle, react and
  unsend offline. The service worker is blocked except in its own test.
- **Settings** are seeded once per browser context (tour done, hints seen,
  Toronto + leisure/figure/other, community off unless a spec turns it on);
  the theme comes from the project.
- **Console and page errors** fail a test (`app.noErrors()`).

## Running

```bash
npm install                      # once
npx playwright install chromium  # once
npm test                         # every spec: the unit project + four browser projects (desktop/phone × light/dark)
npm run test:unit                # the alert logic only, no browser, about 3 seconds
npm run test:headed              # watch it on desktop-light
npm run test:report              # open the last HTML report
```

Visual baselines live in `__screenshots__/<project>/visual.spec.js/`. They are
compared at 2 % pixel tolerance with animations disabled. After a change that
is *meant* to move pixels (the CSS consolidation, a redesign), look at the
diff in the report, then re-baseline deliberately:

```bash
npm run test:visual:update
```

## What is covered

| Spec | Covers |
|---|---|
| `schedule.spec.js` | boot without community code, search, filters sheet, pills, Free only, end-of-day, saved ♡ across reload, card menu (title, ✕, Escape), every alert level, unverified / price / rentals / live spots, cities, calendar, the Update bar and ↻ self-update, the service worker's cache-first assets, phone layout invariants, the install hint |
| `rinks.spec.js` | pins and rows, counts that agree across kind and city filters, alerts and facts per row, tapping a row opens its pin, a postal code and the You marker, the green rink pill |
| `settings.spec.js` | theme, 24-hour time, Chats on/off (code loads on demand, sockets close), privacy toggles, Notify refusal path, backup export and import on a fresh profile |
| `community.spec.js` | rooms, send → settle, react, unsend, private group + invite + leave, the feedback sheet, the guides tab |
| `visual.spec.js` | screenshots of the schedule, filters sheet, rinks sheet and settings per project |
| `status.spec.js` | the status line in two parts and the Data status sheet behind "checked": the City's own checks, a row per source worded by how its last read went (read, not read since, not open yet, opens on a date, closed for the season, out of season, no public skating, entered by hand, its page edited since), sources that are one place merged into one row, the city filter narrowing it, a file from before v3.12, hostile text in the file, a 320 px phone |
| `distance.spec.js` | Within N km (Filters chips, the pill and its menu, a reload, forgetting the spot, asking for a spot first), the ▾ beside Calendar and its four calendars with their colours, the planner's by-distance bands and radius chips, by distance with no spot |
| `homepage.spec.js` | the site's front page (the Nostr timeline viewer at `/`): its script loads, the page's content security policy holds, no handler attributes, hostile profile and note text shows as text, relays and saved state are validated |
| `filters.spec.js` | nothing in the data is ever dropped from Filters: a city with only paid sessions stays listed (at 0) with Free only on and can still be picked, and in the city pill's menu; every kind of skating stays listed at 0 |
| `hockey.spec.js` | Hockey by kind (v3.14): Pickup (shinny) and Stick & puck as ticks under Hockey (both always offered (0 when a city has none of one), both on with Hockey, untick one to hide it, untick both and Hockey is off, the first tick turns Hockey on), ages that follow the kinds ticked (empty ones hidden, one with nothing left let go), the pill's ticks, the numbers following the cities and Free only, a pick at 0 kept, stored junk ignored |
| `prompts.spec.js` | the Update bar not fooled by a script the app loads later (and still shown for a real release), the install card's buttons readable (contrast 4.5:1 or more), a filter that needs a spot asking inside Rinks & map with nothing over the search box |
| `search.spec.js` | the Rinks & map search: the best match first (name, other name, area, street; nearest inside each), one list while searching, rows, pins and the city picker kept between letters, the 80-row limit and its hint, one pass per frame; and three iPhone habits: no field under 16px on a touch screen, the rinks sheet held sideways, the page put back after a rotation or the keyboard (not under the keyboard, not when pinched in) |
| `places.spec.js` | a rink's other names in both searches and beside its name, the City's second id for one rink, a seasonal rink that is not open (and its free skates waiting for it), a City notice an arena has outlived shown as a note, the weather note on outdoor rinks that post their own hours, the natural ice list (no file, last winter's list, nearest first, hostile names) |
| `unit/sources.spec.js` | the pipeline's v3.12 plumbing: season phases (in, lead-in, out), one source's run in every state (ok, pending, dormant, failed with what is kept), venue sessions into records, YZD's hand-entered hours (and the page list that says when YZD edited its page afterwards: an edit, a whole-site republish, a list that cannot be read, last winter's hours), the rinks the City lists twice folded against the published rink list, aliases, the outlived notice |
| `unit/network.spec.js` | the updater and its own network: telling "this machine is offline" from "that site failed", waiting for the network and reading again, a second try at the end of the run, a last read standing in for three hours at most, several unrelated silent sites counted as our outage (one booking service down for five cities is not), errors with no message |
| `unit/calendar.spec.js` | monthly calendar pictures (Ford Performance Centre): finding the picture on the page (`unit/venues/fpc-programs.html`), a reading believed only when every date sits on its weekday, one model call per picture (cached by its bytes), a misread retried after a day, the next month not up yet, no key and no reading |
| `unit/titles.spec.js` | every session title in the live data (`unit/titles.json`) lands in a sensible kind: nothing but breakdancing under Other, every hockey title Pickup or Stick & puck, 55+ skates as leisure |
| `unit/wiring.spec.js` | every source the updater reads has a label, a site and a city in the app, its city in the city order, Toronto ones in a status group, no stale app entries |
| `unit/towns.spec.js` | Aurora's skating page, Newmarket's public skating and shinny PDFs, Whitby's arena tables and U of T's Varsity Arena grids (`unit/towns/`, as served on 2026-11-24): times, seasons, cancelled days (applied to every session marked ">"), dated one-offs, free holiday skates, ages from labels and birth years, the PDF addresses found on the schedules page, junk read quickly as nothing |
| `unit/natural.spec.js` | the natural ice stage against the City's page as served on 2026-11-21 (`unit/natural-ice-page.html`): 48 parks with ids (five through web-archive links), the season on the page against today's winter, pages that are refused |
| `unit/venues.spec.js` | the venue page readers (`skate-venues.js`) against excerpts of each venue's real page in season, before it and after it (`unit/venues/`) |
| `lending.spec.js` | free skates: no file, before the season, in season (chip only on sessions the van overlaps, the line under a day, a rink's next visit, the Free skates page), 24-hour clock, a malformed file |
| `unit/lending.spec.js` | the pipeline's reader for the City's lending-van schedule against that page as it stood on four days over two seasons (`unit/lending-pages.json`): every row read, the year decided by the weekday, every time spelling, the page's own typos, and joining stops to rinks |
| `gate.spec.js` | the members' entrance (`projects/js/gate.js`) against a stand-in relay and a stand-in app: an ordinary visit never loads it or connects anywhere; a key that is not on the list gets a card and nothing is kept; only a build signed by the pinned release key runs (not one signed by another key, altered, of the wrong kind, or older than one already run); a refused device is wiped |
| `unit/alerts.spec.js` | the app's alert classifier and the pipeline's alert reader against `unit/alert-corpus.json`: every alert the City's feed carried from July to November 2026, the 35 with real sentences hand-labelled and paired with the answer Claude Haiku 5.5 gave. Word rules alone, readings attached, the season rule for ten years ahead, part-of-day alerts, the reader's verification (verbatim evidence, dates and times backed by the text, no secrets in logs), indoor/outdoor inference |

A misread alert in the wild belongs in `unit/alert-corpus.json`: add it, label
what it means (`gold`), and both the word rules and the reader are held to it.

Real touch events are generated for the phone projects (`hasTouch`), so the
touch-target lock in `SkateUI.delegate` and the sheet's checkbox guard run as
they do on a phone. What the suite cannot do is run Samsung Internet itself:
for that, USB-debug a real phone through `chrome://inspect`.
