# Smoke suite

Browser tests for the Toronto Skating app, run with Playwright against the same
static server the dev preview uses. Everything is hermetic:

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
npm test                         # every spec, four projects (desktop/phone × light/dark)
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

Real touch events are generated for the phone projects (`hasTouch`), so the
touch-target lock in `SkateUI.delegate` and the sheet's checkbox guard run as
they do on a phone. What the suite cannot do is run Samsung Internet itself:
for that, USB-debug a real phone through `chrome://inspect`.
