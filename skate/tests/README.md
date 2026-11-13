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
