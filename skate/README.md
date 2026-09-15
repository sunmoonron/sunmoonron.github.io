# [toronto-skate](https://sunmoonron.github.io/skate/)

Toronto's public skating schedule with a community layer on top — group
chats, DMs, community-written guides, voting — running **entirely as a
static page**. No backend, no accounts, no database. City data comes from
JSON files committed by CI (and, since v3.1, cross-checked against
toronto.ca's *live* per-rink schedules); everything social rides on
[Nostr](https://nostr.com) relays over WebSockets — three public ones plus
the site's own; identity and history live in your browser's localStorage.

To run it yourself:

- `node fetch-skate-data.js` (repo root) to grab the JSON files from the
  City of Toronto → `projects/data/`
- Host this folder as static files (GitHub Pages works as-is). Note that
  `index.html` loads the nostr bundle from `../assets/js/nostr.bundle.js`
  — one level **above** this folder — so deploy the repo root, not just
  `/skate`.

---

## 1. The design in one paragraph

The app is three strictly separated layers. **Data** (`config.js`): every
repeated structure — tabs, filter chips, rooms, categories, menu labels,
routes — is a plain table in one object, `window.SkateConfig`. **Utilities**
(`ui.js`): parameterized DOM builders (chips, popovers, modals, delegation)
that turn those tables into markup. **Application** (`app.js`): a single
state object `S`, `Render.*` functions that iterate the config to generate
the UI, and `Actions.*` named intents wired through event-delegation
tables. Below that sits the network layer (`nostr-core`, `chat-v2`,
`guides`, `moderation`) which never touches the DOM, and the data layer
(`api`, `storage`, `settings`) which never touches the network layer.
Adding a room, a guide category, or a filter chip is a one-line config
edit; swapping the static config for an API payload before boot re-skins
the whole UI with zero markup changes.

```
┌────────────────────────── index.html (static shell, no inline JS) ─────┐
│                                                                        │
│  config.js ──► app.js ◄── ui.js          (presentation)                │
│  (data)        │  S / Render / Actions   (state → render → intents)    │
│                ▼                                                       │
│  chat-v2.js   guides.js                  (social features)             │
│      │            │                                                    │
│      ▼            ▼                                                    │
│  moderation.js (profanity + PoW)         nostr-core.js (relay pool)    │
│                                               │ WebSockets             │
│  api.js ◄── storage.js   settings.js          ▼                        │
│  (city data)  (cache)    (prefs)   damus / nos.lol / primal / own relay │
└────────────────────────────────────────────────────────────────────────┘
```

Why this shape: the previous build kept all of this in a 1,700-line
`index.html` with hardcoded chip rows, three copies of the filter-group
logic, and user strings inside inline `onclick` handlers (which was an
actual XSS). Splitting data from rendering makes the repetition
declarative, kills the injection surface (all user content renders via
`textContent`-safe builders + delegation), and makes the HTML a ~500-line
shell whose only job is naming the mount points.

---

## 2. File-by-file

### Presentation layer

**`index.html`** — Static shell only; the only inline script registers the
service worker. The schedule panel (v3.2 "calm" layout) is: one search
field, three text buttons (Filters · Rinks & map · Week), the
active-filter `#active-filters` pills, one `#status-data` line, the saved
countdown card, data warnings, then the list under day headers with a
"Show more" button. Nine modal skeletons (first-visit setup, filters
sheet, rinks & map, what's-new, settings, QR, discover, invite, share),
the floating `#popover`, the pull-to-refresh indicator, and *empty
containers* that `app.js` populates from config at boot: `#view-tabs`,
`#filters-body`, `#rinks-list`, `#chat-filters`, `#guide-cat-filters`,
`#guide-cat-input`, `#settings-timefmt`, `#settings-theme`,
`#settings-sections`, `#settings-privacy`. The tab bar hides itself when
only the schedule is on. Script order at the bottom
matters: bundle → **config** → settings → moderation → nostr-core →
storage → api → time → geo → live → weather → alerts → chat-v2 → guides →
**ui** → calendar → map → tour → **app** → refresh. (`profanity-list.js`
has no script tag — `bootCommunity()` injects it lazily, so schedule-only
visits never download it.) The `?v=` query params are the cache-busting
mechanism — bump them when you change a file.

**`projects/js/config.js`** — `window.SkateConfig`, pure data, zero logic.
The tables and what consumes them:

| Table | Drives | Consumed by |
|---|---|---|
| `version`, `changelog` | The 🆕 What's new modal in Settings and the unseen-release dot on ⚙️ (this is the change ledger — there is no CHANGES.md) | `Render.bootstrap`, `Render.whatsNew` |
| `dataBase` | Optional alternate origin for the data JSONs (home server); `null` = committed copies | `SkateAPI.dataUrl` |
| `views` | The 3 tabs + which gets an unread badge | `Render.bootstrap`, keyboard `1..N` |
| `privacyToggles` | 👻 Invisible / ✉️ Allow DMs / 🛡️ Cloud filter buttons in Settings | `Render.settings`, chat-v2, guides, moderation |
| `subTypes`, `cityOrder` | Age-group checkboxes under each category, and the city chip order in Filters | `Render.filters`, `P.subType`, `P.city` |
| `tourSteps` | Spotlight steps (selector, copy, `sec` for the auto-playing guide); hidden targets auto-skip | `tour.js` |
| `weatherSpots` | The pick-list behind the weather chip | `weather.js`, `Menus.weather` |
| `sourceInfo` | Per-source label, `verified` flag, `site` (the 🏛️ verify-link text) and footnote | `Render.programRow`, `officialSite` |
| `programTypes` | The categories in Filters (keyword matcher; `other` catches the rest) | `P.category`, `P.matchesTypes`, `Render.filters` |
| `activityTags` | Activity-name → colored badge (first keyword hit wins, so order matters) | `P.tagFor` |
| `days` | Day dropdown options | `Render.bootstrap` |
| `programActions` | The per-row button set (❤️ 📋) | `Render.programRow` |
| `chatFilters` | All/Groups/DMs/Muted chips, incl. their badge element ids | chips, `Render.conversations` |
| `rooms` | The default public rooms: name, passphrase, emoji, blurb, `autoJoin`, `defaultActive` | `chat-v2` (room list + first-run seeding) |
| `identity` | Adjective/noun pools for random display names | `chat-v2.initIdentity` |
| `guideCategories` | Guide chips, write-form select, category labels everywhere | `guides.js`, `app.js` |
| `timeFormats` | The 12h/24h segment in Settings | `Render.bootstrap`, settings |
| `actions` | Every context-menu label (with `{name}` templating + `danger` flag) | `Menus.*` via the `A()` resolver |
| `routes` | Hash prefixes `#p=` / `#guide=` → action names; anything else falls through to invite parsing | `Actions.route` |

`chat-v2.js` and `guides.js` read their tables from here **with inline
fallbacks**, so each module still works standalone if config is absent.

**`projects/js/ui.js`** — `window.SkateUI`, the consolidated utility belt:
`el(tag, attrs, children)` (a DOM builder where strings become text nodes —
user content can never inject markup; `html:` exists only for
caller-escaped strings), `escapeHtml`, `parseLocalDate` (avoids the
`new Date('YYYY-MM-DD')` UTC off-by-one), `mapsUrl`, `hueOf/hueDot/shortPk`
(deterministic per-pubkey color dot + `#abc123` tag so two "Skater"s are
visibly different people), `copyText` (Clipboard API with `execCommand`
fallback for iOS/http), `flash` (scroll-to + highlight), **`chips()`** (one
parameterized builder replacing the three hand-rolled filter-chip groups;
emits the exact `filter-chip`/`data-*` contract), `fillSelect`, `Popover`
(positioned context menus, closed on outside-click/scroll/resize),
`Modal` (open/close/any + overlay-click dismissal with an `onDismiss`
hook), and **`delegate(container, table)`** — one click listener per
container, a `[selector, handler]` table, first `closest()` match wins.

**`projects/js/app.js`** — `window.SkateApp`, the application layer.
Internal structure:

- **`S`** — the single app-state object: the filters (`types` = per
  category `'all'` or a list of age sub-types, `cities`, `day`, `age`,
  `savedOnly`, `paidVisible`, `rinkScope`, `sort`, `nearRink`), the list
  `limit` ("Show more"), which guide/conversation is open, composer reply
  state, share context, pending deep-links, and the jump-pill
  bookkeeping. Types, cities, paid, scope and order persist via
  `SkateSettings`; day, age, saved-only and ended-shown are per visit.
  Module-owned state (messages, rosters, votes) stays in the modules; `S`
  is only what the *UI* needs to remember.
- **`P`** — program field helpers (the city JSON has inconsistent column
  names like `Activity` vs `Activity Title`) plus the classifiers:
  `category` (keyword table → hockey/leisure/…/other), `subType` (title
  words + age bounds → all/child/youth/adult/older/women — what the
  age-group checkboxes filter on), `city` (source-level label, else
  District) and `matchesTypes`.
- **`Render.*`** — DOM generation. `bootstrap()` builds everything the
  HTML used to hardcode; `pills` (active filters as removable pills, plus
  the standing ⭐ My rinks toggle), `filters` (the sheet, with live
  counts per category, age group and city), `status` (one line: count ·
  ✓/⚠️ freshness), `programs/programRow/showMore` (rows grouped under
  sticky day headers), `rinks` (map + nearest list + star toggles),
  `chatUI/conversations/activeChat/members/discoverRooms/sharePicker/
  mutedList/settings/notif`, `guides/guideDetail` (which builds the
  threaded comment tree: roots chronological, all descendants one visual
  level deep with a "↪ parent" marker, depth-first order). Renders are
  cheap full re-renders of a region; the one guard worth knowing is the
  **votes snapshot** — programs only re-render on chat updates when a
  vote actually changed, so typing in chat doesn't repaint the schedule.
- **`Menus`** + **`A(id, vars)`** — context menus as ordered lists of
  action-ids; `A()` resolves the label template from `config.actions`,
  availability and handlers stay in code.
- **`Actions.*`** — every user intent as a named function
  (`applyFilters` over the pure `computeFiltered()`, `setType /
  toggleCity / setDay / setAge / setSort / setFlag / removePill /
  resetFilters`, `openRinks / useMyLocation / searchLocation /
  filterToRink / toggleMyRink`, `focusProgram` — which widens filters if a
  deep-linked program is hidden, then flashes it —, `openGuide`,
  `toggleGuideVote`, `sendCurrent`, `confirmInvite`, `route`, …). The
  delegation tables in `bind()` map `data-*` attributes to these.
- **`init()`** — boot sequence, see §3.

### Social / network layer

**`projects/js/nostr-core.js`** — `SkateNostr`, one shared relay pool for
the whole app (4 sockets total: `relay.damus.io`, `nos.lol`,
`relay.primal.net` and the site's own `skate-relay.ronishbhatt.com` — a
strfry whose write policy admits only this app's kinds, each gated by the
same NIP-13 proof-of-work tiers the client mines, plus the site owner's
pin/mute lists; unmined events simply get an OK:false from it). Named
subscriptions replay automatically on
reconnect; exponential backoff (1s→30s); global event-id dedupe so the
same message from three relays renders once; `publish()` resolves `true`
once **any** relay ACKs (that's what the ✓/⏳/⚠ delivery ticks mean);
signature verification on every inbound event; intentional-shutdown flag
so leaving doesn't spawn zombie reconnects.

**`projects/js/chat-v2.js`** — `SkateChat`, the big one: groups, rooms,
DMs, presence, votes, invites, mutes, favorites.

- *Groups & rooms.* A group is a shared 32-byte secret. The group id is
  derived from the secret; message content is nip44-encrypted with a key
  derived from it, published as **kind 42** with a `#g` tag. Public rooms
  are just groups whose secret is `sha256(passphrase)` of a passphrase
  printed in the config — public by construction, but identical
  machinery. Private groups get a **random** secret (this is why two
  strangers picking the same password no longer collide into one global
  group).
- *Invites.* Three hash formats: open `#i=<groupId>.<b64 secret>.<b64
  name>`; password `#j=<groupId>.<b64 nip44(secret, key(password))>.<b64
  name>` — the link alone mathematically cannot join a password group;
  and legacy bare 64-hex (treated as an open invite). All three open a
  confirmation modal; nothing autojoins from a URL.
- *First-run seeding.* On a device's first visit, every config room with
  `autoJoin: true` is joined silently and the `defaultActive` room
  (General Chat) becomes the open conversation. A persisted `seededRooms`
  flag makes this run exactly once, so leaving a room later is respected
  forever.
- *DMs.* **Kind 4** envelopes with **nip44** payloads (modern crypto in
  the classic-DM kind so relays index it by `#p`), fetched both directions
  (to-me and from-me) so your own sent history survives a reinstall.
- *Presence.* Ephemeral **kind 20104** heartbeats every 45s per group
  (mined at the chat tier so the site's own relay accepts them); members
  count as online within a 90s window; an explicit `bye` payload on
  `pagehide`/leave zeroes you immediately (kills the "2 online" ghost) and
  wipes your roster entry if you never wrote anything. Rosters are keyed
  by pubkey, not display name. **👻 Invisible** skips the heartbeats *and*
  tags every outgoing payload with `inv`, so receivers keep your name but
  never your "last seen" — a message from an invisible member no longer
  flips them "online" for everyone else (the v3.0 bug).
- *Time votes* were cut in v3.2; incoming `vote` payloads from older
  clients are ignored.
- *Local-only niceties.* Favorites (`skate_favorites_v2`) and mutes
  (`skate_muted_v1`) never touch the network; muting filters messages,
  pings, and unread counts on your device only.
- *Persistence.* Everything lives under `skate_chat_v8` (messages capped
  at 200/group); a `v7` payload found at load is migrated in place,
  including rebuilding pubkey rosters from old messages.

**`projects/js/guides.js`** — `SkateGuides`, the community knowledge base
on standard public Nostr kinds:

- Guides are **kind 30023** (long-form, replaceable — edits by the same
  author replace in place) tagged `#t=tskate-guide` + a category tag.
- Comments are **kind 1111** tagging the guide root; replies add a second
  `e`-tag pointing at the parent comment — one subscription catches the
  whole tree because everything still tags the root.
- Votes are **kind 7 reactions**, `+` to vote and `-` to retract, counted
  as **latest-reaction-wins per pubkey**: every client, including a brand
  new visitor receiving events in arbitrary order, counts only people
  whose *newest* reaction is `+`. This needs zero relay cooperation
  (relays honor NIP-09 deletes inconsistently, which is why deletes were
  rejected as the mechanism). Equal timestamps — possible from legacy
  clients whose miner rewrote `created_at` (see moderation.js) — resolve
  deterministically in the retraction's favor so all clients converge.
- The interactions subscription re-issues (debounced) whenever the set of
  guide/comment ids grows, so votes on brand-new comments stream in live.
- Pinned guides come from **kind 30000/30001** lists signed by the site
  owner's pubkey.

**`projects/js/moderation.js`** — `SkateMod`, two unrelated jobs that both
gate publishing:

- *Profanity*: local word-boundary regex over `PROFANITY_LIST` (with leet
  normalization) as an instant hard block — the mandatory floor; remote
  APIs are consulted **only for public-room content and guides**, and
  only while the 🛡️ Cloud filter setting (`remoteModeration`, default on)
  is on — DMs and private groups are checked on-device only (privacy),
  and the composer says which applies right above the message box.
  `clean()` stars out matches when displaying others' messages.
- *Proof-of-work (NIP-13)*: spam costs CPU. Difficulty by event type:
  chat **8** bits, comment **12**, vote **16**, guide **20**. Mining runs
  in a Web Worker (main-thread fallback) using a **custom miner that
  never touches `created_at`** — the stock `nostr-tools` `minePow`
  rewrites `created_at` to "now" every second while mining, which
  destroyed the strictly-increasing timestamps that vote-retraction
  ordering depends on (a `+` and `-` mined in the same wall-clock second
  came out with equal timestamps, so other clients rejected the `-`).
  `eventPow()` on the receiving side honors only the difficulty the
  author *committed to* in the nonce tag, per NIP-13, so lucky hashes
  don't count.

### Data & preferences layer

**`projects/js/api.js`** — `SkateAPI`. Loads program data from
`projects/data/skating-programs.json` and caches metadata through
SkateStorage. Also exposes `getMetadata()` (the "Updated today/yesterday"
stamp) and `needsRefresh()`. **`dataUrl(file, bust)`** is the single
place every data consumer (programs, alerts, live check, rinks, meta)
builds its URL, so `configure({ dataBase })` (or `SkateConfig.dataBase`)
swaps the data origin for the whole app; any failure on the remote
origin falls back to the committed same-origin copies for the rest of the
session. (The old Firebase Storage branch and its `storageUrl` option were
removed in v2.2.)

**`projects/js/storage.js`** — `SkateStorage`, a lean localStorage cache
for the city data (`skate_` prefix): 1-hour TTL that also expires at the
next 8 AM (when CI refreshes), 2 MB size guard, quota-exceeded recovery,
and garbage collection on load. **Not** used for chat — chat has its own
persistence in `chat-v2.js`.

**`projects/js/settings.js`** — `SkateSettings`
(`skate_settings_v1`): `timeFormat` (12h/24h — every timestamp in the app
funnels through `formatClock/formatWhen`, so the toggle applies
everywhere at once), `displayName`, the persisted filter state, theme,
section visibility and privacy toggles (see the localStorage map). Fires
`onChange` so the UI repaints. (`experience` lingers from the retired
new-skater question and only grandfathers old installs past setup.)

**`projects/js/refresh.js`** — `SkateRefresh`, the cleverest small file:
lets any visitor request a city-data refresh *from a static page*. It
publishes a tiny Nostr note tagged `#toronto-skate-refresh` signed by a
throwaway key; a GitHub Action polls relays every ~30 min, sees the note,
refetches the city data, commits, and Pages redeploys. WebSockets aren't
subject to CORS, which is the whole trick. Asks "are you sure?" if the
data is under a week old.

**`projects/js/profanity-list.js`** — just `window.PROFANITY_LIST = [...]`.
Kept as a separate file so the word list never appears in readable source
diffs of logic files.

### v2.0 layer (alerts · geo · time · calendar)

**`projects/js/time.js`** — `SkateTime`. Every program time on the site
is *Toronto wall-clock*; this pins all comparisons to `America/Toronto`
via `Intl`, DST-safe, regardless of device timezone. `epoch(date, time)`
(memoized), `todayKey()`, and `status(p)` → `upcoming / soon / live /
ended` with minute counts — which powers the "Starts in 25m" / "On now ·
40m left" chips, the real end-time past filter (events vanish when they
*end*, not at midnight), and the date+time sort.

**`projects/js/alerts.js`** — `SkateAlerts`. Loads
`projects/data/alerts.json` (a CI snapshot of toronto.ca's live skate
alerts — that endpoint sends no CORS headers, so the browser can't fetch
it directly) and classifies per program: Status 0 closures flag a session
"likely cancelled" **only when the closed pad kinds cover every rink kind
at that location** (an outdoor pad hibernating for summer must not cancel
an indoor program — pad kinds come from rinks.json); Status 2 alerts stay
warnings unless the text clearly says the rink itself is closed and any
mentioned date range covers the program date. Deliberately deterministic:
every flag traces to a rule, and the full alert text is always shown so
the human decides.

Since v3.1 it also loads **`projects/data/live-check.json`** on the same
ticker: the pipeline's cross-check of every City session in the next two
weeks against toronto.ca's *live* per-location schedules (see the data
section). `liveFor(p)` / `isDropped(p)` expose the verdict, and
`forProgram()` returns a `closed` verdict with `live` set when the City
no longer lists a session or marks it cancelled — that outranks the
alert feed. Dropped sessions are struck out with a red flag, never count
as "upcoming", and carry a **Verify on toronto.ca ↗** link. The stats
line shows "· toronto.ca ✓ HH:MM"; a banner warns when the check is >8h
old.

**`projects/js/geo.js`** — `SkateGeo`. Loads `projects/data/rinks.json`
(all indoor + outdoor pads with coordinates), haversine distances, the
📍 locator (browser geolocation or Nominatim geocoding biased to the
Toronto viewbox; Canadian postal codes try Nominatim's exact postcode
search, then place the postal area from Photon's addresses, labelled
approximate), persisted user location, `nearest()` for the locator
modal and `distanceForProgram()` for the row badges / nearest sort.

**`projects/js/calendar.js`** — `SkateCalendar`, a pure renderer for the
week view: Monday→Sunday columns from the *current filtered* programs,
today highlighted and auto-scrolled into view, blocks styled by state
(paid gold, saved ring, alert struck, live pulsing). Click handling stays
in app.js via `data-pid` delegation. Careful: no `scroll-snap` on the
grid — a freshly created snap container re-snaps to its first column,
which silently undoes the scroll-to-today.

**`projects/js/live.js`** — `SkateLive` (v2.2). Live "spots left" for
paid venues, fetched by the BROWSER from DaySmart's CORS-open API (one
batched `filter[id__in]` request joined on the records' `ExternalId`,
TTL-throttled to 5 min, ≤60 ids). Renders as the 🎟 badge / "Registration
closed" chip on paid rows. Cross-origin failures are silent — the badge
just doesn't show.

### v3.0 layer (map · weather · tour · privacy)

**`projects/js/map.js`** — `SkateMap`. Interactive rink map: Leaflet is
VENDORED (`assets/vendor/leaflet/`) and lazy-injected on first open, so
non-map visitors download zero map bytes. OSM tiles (attributed); dark
mode re-inks tiles with a CSS filter. Pin popups come from app.js via
`configure({popupHtml,userPoint})` — same content/chrome split as the
calendar. It now lives inside the Rinks & map view (`#rinks-modal`),
next to the nearest-rinks list; `open({filter:'outdoor'})` is still there
for callers that want the outdoor pins only.

**`projects/js/weather.js`** — `SkateWeather`. Open-Meteo current
conditions (30-min TTL, CC BY attribution) for the stats-line chip.
`spot()` is either a pick from `config.weatherSpots` (Scarborough, North
York, Markham, Mississauga… — chosen from the chip's popover, persisted
as `weatherSpot`) or, on 'auto', the user's saved 📍 location, falling
back to central Toronto.

**`projects/js/tour.js`** — `SkateTour`. Spotlight coach marks, two ways:
`start()` is the tap-through quick tour (runs once after first-visit
setup), `play()` the auto-advancing ~60-second guide with a progress bar
and Pause — both from Settings. Steps live in `config.tourSteps`
(missing/hidden targets auto-skip; `sec` sets the guide's dwell time).
Skip always outranks: first button in the card, Esc, tap on the backdrop.

**Markham (PerfectMind)** — `EXTERNAL_SOURCES['markham']` posts to the
city's own `ClassesV2` widget endpoint; records carry `ExtLocationKey`
(per-venue key) so one multi-venue calendar becomes many locations.
Adding a venue's coordinates = one line in `venues{}`. Privacy toggles
(👻 invisible, ✉️ DMs) gate presence pings / incoming DM ingestion in
chat-v2 via `SkateSettings`.

### v3.4 layer (the readable schedule)

**First visit.** No welcome form. `Actions.firstRun()` sets the defaults
once (cities `['Toronto']`, types leisure + figure, Guides and Chats off),
marks `setupDone`, and the spotlight tour starts after the first render
with Skip as the loudest button on its card. Community sections are
switched on in Settings.

**Top bar** carries the Paid switch (`#btn-paid`, gold when on), Refresh
(`#btn-refresh`, a silent `reloadData`; the City doorbell moved into the
status popover as "Ask for a fresh pull") and Settings. The toolbar's
third slot is a List / Calendar segmented switch (`#view-seg`,
`Actions.setCalMode`), so the current view is always visible.

**Pills.** A standing city pill comes first: tap it for a multi-select
popover (`Menus.cities`), its x clears to every city. Type pills work the
same way for age groups (`Menus.subTypes`): tap to pick Child & family,
Youth, Adult, Older adult, Women; "Every age group" restores the whole
type; the x drops the type. The Where cities
also scope the Rinks list and the map pins (`rinkInScope`, passed to
`SkateMap.configure({ rinkFilter })`; "Show every city" is one tap in the
rinks view).

**Filters sheet.** Leisure, Figure and Hockey up front with an "Ages"
button that folds the age groups; the other types behind "More types";
When and Where; then a folded "More options" for age, ended sessions,
saved-only, dropped sessions and order. `S.expandedCats` and
`S.moreFilters` remember the folds for the session.

**Rows.** Two lines: title over the rink line, where the rink name is
the directions link (📍 name ↗), 📄 beside it opens the official page and
📝 (rare, `locationNotes`) toasts the rink note; city tag and distance
follow. Then a footer grid with the type badge (capitals + emoji), the
age pill and the price tag, ♡ and ⋯ on the right. Register/Details
appears as a third line only on paid rows that have it, the price note on
its own line. The ⋯ menu adds "Add this rink
to my rinks". The first card carries a one-time "tap ♡ to save" hint
(`heartHintDone` setting; a first save or "Got it" retires it).

**toronto.ca is the ground truth.** City sessions the live cross-check
flags as missing or cancelled are hidden (`computeFiltered`,
`S.showDropped`, also excluded from the Filters counts), and live-only
sessions from `live-check.json`'s `extra[]` are merged into `S.programs`
as ordinary City rows (`mergeLiveExtras`, `LiveOnly: true`, address from a
sibling row or rinks.json). The status popover states both counts and
toggles the dropped ones back on. City locations that only exist in the
program rows (Scarborough Arena Gardens, Park Lawn Park) are geocoded
into `rinks.json` by the pipeline (`geocode-cache.json`).

**Rink alerts and multi-pad buildings.** A City alert that names one pad
of a building with several ("Rink 1 is temporarily closed", Don
Montgomery has two) is a warning flagged `padOnly`, never a cancellation:
the row says the session likely runs on the other pad and links the
City's text. Only whole-facility wording ("arena closed", "both rinks")
or a single-pad building can still produce "likely cancelled". The live
cross-check is independent of this: if toronto.ca's schedule drops a
session, it is hidden regardless of alerts.

**Settings** is three groups (Display, Learn and share, Community) with
one button style; modal overlays are neutral black so opening one dims
the page without shifting its hue.

### v3.5 layer (calendar that scales, one-tap calendar export)

**Calendar.** `calendar.js` now renders a day strip (Mon 14 … Sun 20 with
counts; tap to scroll that column into view, the chip in view is
highlighted) over the grid, a fading right edge plus a visible scrollbar
while columns hide off-screen, and week arrows labelled "‹ Week" /
"Week ›". A day holding more than `maxBlocks` (8) sessions folds sessions
that start in the same hour into one dashed time block ("10:00 AM–12:00 PM
· 5 sessions · Malvern, Agincourt +3", type dots, paid count); tapping it
expands it in place (`Actions.toggleCluster`, `S.calOpen`), its sessions
appearing as ordinary blocks beneath it, tap again to fold. Nothing
leaves the grid, and the minute re-render keeps the grid's scroll
position (`S.calRenderedWeek`). Single sessions in a crowded day stay
ordinary blocks. Text size never changes.

**Add to calendar** is one tap: Apple devices open a real https `.ics`
(`Actions.addToCalendar` → `openIcs`), Android opens the Google Calendar
template link, other desktops get the Google / Outlook / .ics popover.
The `.ics` files are pre-built per session by the home server (pipeline
`writeIcsFiles`, `ICS_DIR`; id = the favourites hash, mirrored in
`favouriteId`) and served at `https://skate-data.ronishbhatt.com/ics/<id>.ics`
as `text/calendar` with open CORS. Times are wall-clock with a
`VTIMEZONE` for America/Toronto, so Calendar shows "11:30 AM EDT" rather
than a GMT conversion. iOS opens the URL (it refuses top-level `data:`
URLs, which is why the old "Apple" option did nothing on phones); every
other platform fetches the file and saves it directly, no new tab, so the
same click can be repeated. Without the home server the client builds
the same file itself.

**Saved sessions** that have ended are removed on the minute tick
(`pruneEndedSaved`, `Favorites.remove` is silent), and the card above the
list shows every saved session on the soonest day, each row jumping to
its session.

**Data origin check.** `SkateAPI.pickOrigin()` fetches both `meta.json`
files before the first load and uses the committed copy when the home
server is unreachable or more than an hour behind it (a power cut leaves
the Dell serving whatever it last published; the GitHub cron keeps
moving). A manual Refresh re-checks.

**First visit** plays the auto-advancing guide (`SkateTour.play()`, pause
and skip on the card) instead of the tap-through tour.

### PWA (v2.2)

**`manifest.webmanifest` + `sw.js` + `assets/icons/`** — installable app
(CN-Tower-on-a-skate icon; the SVG master is rasterized to 512/192/180
PNGs). The service worker is deliberately boring: NETWORK-FIRST for every
same-origin GET with cache fallback — zero staleness while online, and
the last-loaded schedule stays browsable offline. Cross-origin requests
(relays, DaySmart, Nominatim) are never intercepted. Bump the `CACHE`
constant in sw.js on releases that must evict old assets.

### Styles

**`assets/css/style.css`** — the original base stylesheet. Deliberately
untouched: the refactor's contract is that every class/id/data-attribute
the old markup used still exists, so this file keeps working blind.

**`assets/css/style-v3.css`** — loaded last: everything from v2.0
onwards — alert banners, live chips, paid styling, the week calendar,
locator/my-rinks/what's-new, the v2.5 **"night rink" dark theme** (a full
token re-base under `body.dark-mode`, so any new light-hardcoded colour
needs an override here), the v3.0 weather/QR/map/winter/tour styles and
the v3.1 live-flag, verify-link, pull-to-refresh, privacy-line and guide
styles. Every new component gets its dark override in this file.

**`assets/css/style-additions.css`** — the v2 layer, loaded
*after* base so it wins ties: the panel accent system (ice-blue Programs /
violet Guides / amber Chats via `--acc-*` custom properties, 3px gradient
bars, tab underlines), the responsive layout overrides (**<768px** tabbed
via base styles; **768–1099px** re-tabbed, undoing base CSS's
all-panels-side-by-side desktop mode; **≥1100px** a deliberate 3-column
grid with Programs widest), clickability affordances (bordered icon
buttons with hover rings, member chips, `:focus-visible`), and all
new-component styles (conversation list, popover, reply bars, comment
threads, jump pill, hue dots), plus dark-mode fixes for colors the base
hardcoded. One landmine documented inline: never add an **unscoped**
`.view-panel { position: relative }` here — it overrides mobile's
`position: absolute` and collapses the scroll container (that was the
"can't scroll on my phone" bug).

### Data & other

**`projects/data/`** — `skating-programs.json` (the schedule: city
drop-ins **plus** external venues — five Canlan Sports rinks (York,
Etobicoke, Scarborough, Oakville, Oshawa) via the DaySmart API with live
prices; Markham, Vaughan, Brampton, Oakville and Burlington via their
PerfectMind booking calendars; Mississauga and Richmond Hill (Ed
Sackfield) via ActiveNet drop-in calendars; Oshawa's two city arenas via
its Intelligenz booking pages (kind `intelligenz`: a cookie-jar redirect
loop through the Queue-it gate, one server-rendered page per arena);
Whitchurch-Stouffville and Ajax from the PDFs their towns publish (kind
`pdf`: discovered from the listing page each run, `pdftotext -layout`,
a weekday-grid parser for Stouffville's sheet and a weekday-lines parser
for Ajax's flipbook, "Unavailable" dates honoured); Pickering from the
plain tables on pickering.ca (kind `html-grid`, season dates and the
cancellation list read from the surrounding text, free); Moss Park Arena
scraped from their site. Every scraped or PDF source is marked
`Unverified`. Researched and *not* wired: Richmond Hill's other arenas
only exist as weekly activity patterns, and Oshawa's Harman Park Arena
had no fall ice published (see `docs/data-sources/`)), `rinks.json` (every indoor/outdoor
pad with coordinates + kinds, feeds the locator and alert matching),
`alerts.json` (toronto.ca service-alert snapshot — only rewritten when
content changes or the 2-hour heartbeat is due), **`live-check.json`**
(see below), `meta.json` (`lastUpdated` + per-source health). Written by
`fetch-skate-data.js` in CI; treated as read-only by the app.
External program records reuse the exact city field names plus
`Source / ExternalId / Paid / Price / RegistrationUrl / InfoUrl /
Unverified / Lat / Lng` — adding a venue is a config entry in
`EXTERNAL_SOURCES` at the top of `fetch-skate-data.js` (an optional
`ANTHROPIC_API_KEY` secret upgrades the Moss Park scrape to an LLM parse;
the regex parser is the always-on fallback). `node fetch-skate-data.js
--only=stouffville,ajax` dry-runs the named sources and writes nothing —
the way to develop a parser. The two PDF sources need `pdftotext`
(poppler); the workflow apt-installs it, and without it they fail
cleanly and keep their previous rows like any other failed source.

**The live cross-check (`live-check.json`, v3.1) — the Malvern lesson.**
The City's open-data drop-in export is refreshed *weekly* and lags the
live registration system: on 2026-09-14 it still listed "Leisure Skate:
Adult" at Malvern five times that week while toronto.ca's own facility
page listed none, and a visitor travelled there for nothing. toronto.ca
renders its facility pages from per-location week feeds
(`/data/parks/live/locations/<id>/skate/info.json` → `weekN.json`,
served as UTF-16), so `fetchLiveCheck()` reads them for every City
location with sessions in the next 14 days and writes `flags`
(`"<LocationID>|<date>|<start>|<normalized title>"` → `missing` or
`cancelled` + the City's comment) plus `extra` (live-only sessions the
export lacks). It never flags on silence (an unreadable feed skips the
location), ignores sessions already over today, and rewrites the file
only on change or the 2-hour heartbeat. It runs in the full refresh and
in every light pass (`--alerts-only`). Since v3.4 the client treats it as
the ground truth: flagged sessions are hidden and `extra` sessions are
shown (see the v3.4 layer above).

**Workflow cadence, honestly.** `update-skating-data.yml` runs Sunday and
Friday mornings (the City refreshes its export mid-week). The listener
is scheduled `*/15`, but GitHub fires a low-traffic repo's cron only
about 7× a day (median gap ~3.3 h, worst ~7.5 h measured over two weeks,
every run successful) — so the alert and live-check stamps are hours
old, not minutes, and the client's stale banners are the honest signal.
A home-server daemon (§7) is the fix; the cron stays as the fallback.

**`../assets/js/nostr.bundle.js`** — the `nostr-tools` browser bundle
(keys, signatures, nip44 encryption, event hashing). Lives at the **repo
root**, shared with the parent site. Also `importScripts`-loaded into the
PoW worker.

**Change ledger** — `config.js` → `changelog` (rendered by the 🆕 What's
new modal in Settings, with a dot on ⚙️ for unseen releases). Root-cause
writeups live in the module headers.

---

## 3. Boot sequence & data flow

1. Scripts load in dependency order (see §2); nothing renders yet.
2. `SkateApp.init()` runs: `Render.bootstrap()` generates tabs/chips/
   options/segments from config → dark mode applied → `bind()` attaches
   all delegation tables → the first-visit setup sheet on a brand-new
   install.
3. `SkateAPI.getSkatingPrograms()` (cache-first) → `Actions.applyFilters()`
   → schedule renders. A pending `#p=` deep-link resolves here.
4. `SkateChat.init()`: load/migrate state → identity → derive room
   secrets → **seed default rooms if first run** → connect relays →
   subscribe (group kind 42 + presence 20104 by `#g`, DMs kind 4 both
   directions) → start presence heartbeat. Every state change fans out
   through `onUpdate` → `Render.chatUI` (throttled to one repaint per
   animation frame).
5. `SkateGuides.load()`: subscribe kind 30023 by tag + owner pin lists;
   at EOSE, open the interactions sub (kinds 1111 + 7 by `#e`). Updates
   fan out to a rAF-debounced guides render.
6. `Actions.route()` handles the current hash and listens for changes.

Interaction flow is always the same shape: DOM event → delegation table →
`Actions.*` → module API (optimistic local update → PoW mine → sign →
publish → revert + toast on total relay failure) → module `notifyUpdate`
→ `Render.*`.

---

## 4. localStorage map

| Key | Owner | Contents |
|---|---|---|
| `skate_chat_v8` | chat-v2 | Groups, rooms, DM threads, secrets, active conversation, `seededRooms` flag (v7 migrates in place) |
| `skate_identity_v1` | chat-v2 | Your Nostr keypair + display name (this browser **is** your account) |
| `skate_favorites_v2` | chat-v2 | Saved program ids |
| `skate_muted_v1` | chat-v2 | Muted pubkeys (local only) |
| `skate_settings_v1` | settings | timeFormat, displayName, typeSel, cities, paidVisible, rinkScope, myRinks, sort, calMode, userLoc, theme, showGuides/showChats, setupDone, tourDone, invisible, dmsAllowed, remoteModeration, weatherSpot, lastSeenVersion |
| `darkMode` | app | `'true'`/`'false'` |
| `skate_<dataset>` + `_meta` | storage | Cached city JSON with TTL |
| *(session)* `skate_seen_this_session` | app | Suppresses the guides-first redirect for returning "new skater" users within a tab session |

Clearing site data = a fresh identity. There is no recovery — that's the
tradeoff of accountless.

---

## 5. Extension recipes

- **Add a public room** — one entry in `config.rooms` with a *unique*
  passphrase. `autoJoin: true` if newcomers should be seeded into it
  (only affects devices that haven't seeded yet).
- **Change the first-visit defaults** — `Actions.firstRun()` in `app.js`
  (cities, types, which community sections start off).
- **Rink list rows** show address, indoor/outdoor and paid; the upcoming
  count lives on the Sessions button (disabled when there is nothing).
- **Add a guide category / activity category / age group / menu label**
  — add a row to the matching config table (`programTypes` keywords,
  `subTypes` — extend `P.subType` if a new group needs new words). The
  Filters sheet, pills and matchers follow.
- **Add a per-program button** — a row in `config.programActions` + a
  branch in the `program-list` delegation handler in `app.js`.
- **Add a price note** — `priceNote` (string or `price => string`) on the
  source in `fetch-skate-data.js` lands on each record as `PriceNote` and
  shows on the row, in shares and in calendar exports (Vaughan's
  "free for residents only" uses it).
- **Swap the data source** — set `SkateConfig.dataBase` (or call
  `SkateAPI.configure({ dataBase })` before boot) to another origin that
  serves the same five JSON files with CORS for this site; the committed
  copies remain the fallback and the offline copy. Or replace
  `window.SkateConfig` wholesale from a fetch — the renderers only ever
  read the object.
- **Add a Canlan facility** — one `EXTERNAL_SOURCES` entry (kind
  `daysmart`, its ice-rink `resourceIds` — their API ignores facility
  filters — coordinates, `registrationUrl`), a `SOURCES` line in
  `live.js` for live spots, and a `sourceInfo` row in config.
- **Add a PerfectMind city** — an `EXTERNAL_SOURCES` entry with `base`
  (org path included), `widgetId`/`calendarId` (from the city's booking
  page network calls), `windowDays` small enough that no window returns
  ~50 classes (their `ClassesV2` truncates windows silently and `page`
  skips ahead 14 days regardless — the fetcher uses the Date Range filter
  and re-fetches day by day when a window looks clipped), an `include`
  regex to keep only public skates, and `venues{}` for the rink
  inventory (coordinates also get learned from the feed's Address block).
- **Add an ActiveNet city** — kind `activenet` with the calendar id,
  category ids, centre ids and `programs` rules carrying price + ages
  (that API exposes neither).
- **Add a PDF-only town** — kind `pdf` with `discover` (listing page +
  one regex per hop to the PDF; `pdfUrl` as the fallback), `layout:
  'weekday-grid'` (a header row `Activity | Age | Monday … Sunday` per
  venue block, like Stouffville's sheet — tokens land in the column whose
  header centre is nearest, never in fixed slices) or `'weekday-lines'`
  (a weekday on its own line, then `time  activity  pad  Unavailable …`
  lines, like Ajax's), `programs` rules for names, ages, prices and
  `skip`, `venues{}` and `unverified: true`. Test with `--only=`; the
  season range on the sheet bounds the expansion, `grid.stopAt` ends the
  grid before the fee tables.
- **Add an Intelligenz booking site** — kind `intelligenz` with `base`,
  `venues{}` carrying each arena's `guid` (from its VenueClasses link),
  `activityMatch` to drop the yoga and pilates on the same page, and
  `programs` price rules; the fetcher keeps the Queue-it cookies across
  the redirect chain by itself.
- **Add an HTML weekday grid** — kind `html-grid`: `url`, `venues{}`
  (+ `venueAliases` for the short names the page uses), `programs`
  renames, `seasons` (a label regex per program group → the date range
  that follows it) and `cancelGroups` (label regex → program regex under
  "Cancellation Dates"; venue-qualified lines apply to that venue only).
- **Add a weather spot** — a row in `config.weatherSpots`.
- **Change relays** — `RELAYS` in `nostr-core.js` (chat/guides) and in
  `refresh.js` (must overlap with what the GitHub Action polls). The
  site's own relay enforces the PoW table server-side: its policy lives
  in the dell-nix repo (`modules/relays.nix` AND `modules/strfry-node.nix`
  — keep both in sync with `moderation.js`).
- **Change spam economics** — the `POW` table in `moderation.js`; bumping
  a number makes that event type cost more CPU for everyone, old clients
  included (receivers enforce it).

After any file change, **bump its `?v=` in `index.html`** or GitHub Pages
visitors will run the cached old copy.

---

## 6. Known limitations (by design)

- Identity is per-browser; multiple tabs share it, last write wins.
- Public relays may prune old events — history beyond the backfill window
  isn't guaranteed, and "Clear history" is per-device (Nostr has no
  global delete).
- Any current member of a private group can rename it (no owner concept
  on the wire); renames from muted users are ignored locally.
- Display names are self-asserted; the hue dot + `#pubkey` tag is the
  anti-impersonation signal, not the name.
- Vote retractions leave a `+`/`-` reaction history visible to other
  Nostr clients; the counts are correct everywhere, the history itself
  isn't secret.
- The live cross-check covers City of Toronto rinks only, for the next
  14 days; external venues are only as fresh as their own feeds (Canlan
  and Markham are official booking APIs, Moss Park is a scrape).

---

## 7. Home-server offload (built 2026-09-14)

**Live.** The Dell (NixOS, `dell-nix` repo, `modules/skate-data.nix`)
runs this same `fetch-skate-data.js` every 30 minutes and the light
alerts + toronto.ca cross-check pass every 10 minutes, as a sandboxed
system user on a shallow clone of this repo (pulled fresh each run;
nothing is ever pushed from there). The outputs are published to
`https://skate-data.ronishbhatt.com/projects/data/` through the existing
Cloudflare tunnel with `Access-Control-Allow-Origin: *` and
`Cache-Control: no-cache`. `config.js` sets `dataBase` to that origin;
`api.js` falls back to the committed same-origin copies for the rest of
the session on any failure, so the GitHub cron (still running) remains the
safety net and the offline copy.

What that changes in practice: dropped or added City sessions show up
within 10 minutes of toronto.ca changing, a rink alert reaches every open
page within about 15 minutes (10-minute pass + the client's 5-minute
TTL), and the schedule itself is at most 30 minutes behind the feeds. The
"✓ HH:MM" stamp still follows the heartbeat contract (it moves on change
or every 2 hours), so it can read up to 2 hours old while everything is
being checked every 10 minutes.

Operational notes (on the box): `systemctl status skate-data-full
skate-data-light`, `journalctl -u skate-data-full -n 50`, files in
`/var/lib/skate-data/www/projects/data`, last run stamp at
`/var/lib/skate-data/www/last-run.txt`. `OLLAMA_URL` points at the box's
own Ollama for the one scraped page; the regex parser remains the floor.
Not done: pushing the Dell's output back into this repo (no GitHub
credential lives on the box by design), so the committed copies still
refresh on GitHub's cron only.
