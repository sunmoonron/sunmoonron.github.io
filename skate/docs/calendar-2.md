# Calendar 2.0 — research notes and the experiment

Status: **experimental**, off by default. Settings → Display → "Calendar 2.0".
Code: `projects/js/calendar2.js` (renderer), wiring in `app.js`
(`Render.calendar2`, `Actions.cal2SetMode`, `Actions.cal2SetDay`), styles under
"Calendar 2.0" in `assets/css/style-v3.css`. The classic grid
(`calendar.js`) is untouched and is what everyone sees with the toggle off.

## 1. The problem

The week grid draws seven columns and puts text in every block. On a
phone a column is ~130 px wide, so a Toronto day with leisure + figure on
(60–80 sessions across ~40 rinks) became a wall of "Starts 9:00 AM /
2 sessions · 1–2 h / dot / rink, rink…" blocks. The v3.5 "time blocks"
(fold same-hour sessions) cut the count but not the text, and a block
reading 6–9 PM scared off anyone who only wanted an hour. The grid is a
desktop layout that was scaled down, which is exactly the anti-pattern the
literature warns about.

What people actually ask the calendar (leisure and figure skaters, from
the Discord threads and the user stories in the v3.4 work):

1. "What can I skate **today or tomorrow**, and when?"
2. "Is there anything **Thursday evening** near me?"
3. "Which rink has the best session **at 6 PM** — how long does it run?"
4. "Plan my week."

The week grid answers 4 on a desktop and none of the others on a phone.

## 2. What the research says

- **Agenda over grid on phones.** Mobile calendar design favours a
  chronological list as the primary mode; grids stop being actionable
  below ~360 px. Month/week grids are navigation or overview, the list is
  where reading happens. Dense products show 2–3 items per cell and an
  overflow indicator, or switch to a day view when a day carries more than
  a column can hold. ([Eleken](https://www.eleken.co/blog-posts/calendar-ui),
  [Bricx](https://bricxlabs.com/blogs/calendar-ui-examples),
  [Mobiscroll responsive demo](https://demo.mobiscroll.com/eventcalendar/responsive-month-view))
- **Choose the layout after the task, and design the mobile fallback
  first.** "Responsive behaviour usually needs a deliberate mobile
  fallback, not just smaller text"; avoid horizontal scrolling without a
  fallback; use progressive disclosure for density; never rely on colour
  alone; keep touch targets comfortable; design the empty and loading
  states. ([uxpatterns.dev — Calendar view](https://uxpatterns.dev/patterns/data-display/calendar))
- **The TV-guide (EPG) layout is the standard for "many venues × one
  day".** Roughly 90 % of programme guides use rows = channels, x = time,
  past on the left. People skim a guide rather than study it, so the
  structure has to support scanning; more than ~8 rows on a small screen
  hurts clarity, so rows must be sortable by what matters (here: my rinks
  first, then distance). A selected row expands in place rather than
  navigating away. ([Oxagile on EPGs](https://www.oxagile.com/article/why-epgs-rule-the-screen/),
  [Deltatre EPG page](https://documentation.deltatre.com/docs/epg-channel-guide-page),
  [Android TV program guide](https://github.com/egeniq/android-tv-program-guide))
- **Heatmaps carry "how much, when" with zero text.** The When2meet
  pattern (days × hours, darker = more) is read at a glance and gets more
  useful as counts climb; granularity should adapt (hourly inside a week).
  ([When2meet explainer](https://meetergo.com/en/magazine/when2meet),
  [calendar heat map with d3](https://medium.com/@amit.rai.raniganj/how-to-display-a-calendar-heat-map-monthly-weekly-even-for-a-specified-time-period-for-a-day-with-92d963b631dc))
- **Timetable apps (classes, gyms, conferences) converge on day tabs + a
  list for that day, with "now / next" surfaced and swipe between
  days.** ([MotoPress timetable](https://motopress.com/products/timetable-event-schedule/),
  [Class Timetable](https://apps.apple.com/us/app/class-timetable-schedule-app/id425121147),
  [Smart Timetable](https://smart-timetable.app/))

## 3. The three layouts (one per question)

All three share the day strip (Mon–Sun with counts), the layout bar, the
Today button, the popover on tap (save, show in the list, add to calendar,
directions…), and the same colour key as the list badges.

| Layout | What it is | Answers | Text per session |
|---|---|---|---|
| **Hours** (default) | One day as hour rows; each session is a chip "6:15 Centennial · 1 h" | 1, 3 | start · rink · length |
| **Rinks** | Timetable: one row per rink (★ mine first, then nearest), x = time of day, a bar as long as the session, a now-line today | 3, 1 | start time inside the bar when it fits, else none |
| **Week** | Heatmap: 7 columns × hour rows, darker = more sessions on the ice that hour; tap an hour → Hours at that hour, tap a day → that day | 2, 4 | none (a count) |

Design rules applied:

- The chips and bars are honest about duration (the 6–9 PM complaint):
  the chip prints the length, the bar *is* the length.
- Nothing is expandable or folded; the row/lane structure absorbs density.
  A crowded hour just has more chips, wrapping.
- No horizontal scrolling without a fallback: Hours and Week never scroll
  sideways; Rinks does (a timetable has to) with a sticky rink column, a
  sticky hour header, and the same sessions one tap away in Hours.
- Colour is never the only signal: paid shows "$", saved "♥", alerts strike
  the rink and say so in the tooltip and the popover.
- Empty states are real sentences ("Nothing this day with these filters").
- Now: the current hour row is marked (Hours), a live now-line runs down
  the timetable (Rinks), the current cell is ringed (Week); past hours dim.

## 4. What to look at while testing

- Phone, Toronto, leisure + figure, a weekday evening: Hours should read
  in one scroll; Rinks should show ~10–20 rows with the 6 PM bars lined up.
- Week on a phone: does the heatmap tell you Thursday evening is busy
  without reading anything? Tap a cell: does landing in Hours at that hour
  feel right?
- Rinks: with "Use my location" set, are your rinks on top and the rest
  sorted by distance? Without a location, alphabetical.
- Desktop: Hours is deliberately not a 7-column grid. If the classic grid
  still wins on wide screens, the decision may be "2.0 on phones, grid on
  desktop" — the code allows either.

## 5. Open questions

- Should Week replace the day strip on phones (heatmap as the navigator)?
- Rinks: should a rink with no session that day still appear as an empty
  row (so "my rinks" never vanish)? Currently hidden.
- Should the chosen layout follow the screen width automatically?
- Is a fourth layout worth it: a plain **Agenda** (the list view grouped
  by hour instead of by day)? The list tab already covers most of it.
