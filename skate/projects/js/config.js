/**
 * SkateConfig — the single source of truth for every repeated structure
 * in the app. Pure data, zero logic.
 *
 * The rendering pipeline (app.js) iterates these tables to generate the
 * tabs, filter chips, select options, rooms, categories, context-menu
 * items and routes that used to be hardcoded across index.html and three
 * JS files. Swap any table here (or replace the whole object from an API
 * response before app.js boots) and the UI follows — no markup edits.
 *
 * Contract note: every class / id / data-attribute emitted from these
 * tables is byte-identical to the previous hardcoded markup, so existing
 * CSS and any external scripts keep working untouched.
 */
// Shared by the Leisure filter chip and the Leisure badge (see programTypes).
// Never a bare "unsupervised": Toronto's "Shinny: Adult (Unsupervised)" is hockey.
const LEISURE_WORDS = [
    'leisure', 'public skat', 'recreational skat', 'recreation skat', 'fun skate',
    'skating - unsupervised', 'skating - adult only', 'skating - older adult',
    'senior skate', 'older adult skate', 'adult skate fit', 'sensory skate',
    'parent & tot skate', 'parent and tot skate', 'skate 19+', 'family skate', 'daytime skate',
    // Stouffville "Adult/Senior Free Skate", Ajax/Oshawa "Adult Skate" / "Parent & Tot", Pickering "Parent & Child Skate"
    'free skate', 'adult skate', 'parent & tot', 'parent and tot', 'parent & child skate'
];

window.SkateConfig = {

    /* ---------- Release info (powers the version chip + What's new) ---------- */
    version: '3.5',
    changelog: [
        {
            v: '3.5', date: '2026-09-15', items: [
                'Calendar that scales: a tap-to-jump day strip with counts (and a visible way to swipe on phones), week arrows that say Week, and crowded days fold same-hour sessions into time blocks that open the list for that day. Text never shrinks.',
                'Add to calendar just opens your calendar: iPhone, iPad and Mac get a real .ics from the home server (Apple Calendar), Android gets Google Calendar, other desktops still pick. Saved sessions vanish once they have ended, and the reminder card lists every saved session of that day.',
                'First visit now plays the 54-second guide (pause and skip on the card). The weather emoji is back.',
                'Rink list rows show the street address, so Baycrest Arena and Bayview Arena stop looking like twins.',
                'Rink alerts that name one pad of a two-pad building ("Rink 1 is closed") now say the session likely runs on the other pad instead of "likely cancelled". Thanks to a skater who called Don Montgomery to check.',
                'Data resilience: the app checks which copy is fresher (home server or GitHub) before loading, so a power cut at home never serves stale data.',
                'Session cards are two lines again: the rink name is the directions link (📍), the ℹ️ beside it opens the official page, and the type badge got its capitals and emoji back with the ages as a pill. A one-time hint on the heart shows that sessions can be saved.',
                'Calendar: the lit day chip follows the day you are looking at (today on wide screens) instead of sticking to Monday. The Schedule label only shows when Guides or Chats are on.',
                'Calendar time blocks say "Starts 6:00–6:30 PM · 5 sessions · 1–3 h" instead of stretching one block across the whole evening, and the legend lists only the types and states in the week on screen.',
                'Filters sits beside the search box. A Show all button ends the list. Bigger ♡ and ⋯. The rink note moved onto the rink line (📝) and the official-page icon is a plain 📄.',
                'Postal codes work in the locator: exact when OpenStreetMap knows the code, otherwise the postal area, marked approximate. The guide has a Back button. The saved-day card shows time ranges, durations, distance and any rink alert.',
                'Fixed: the page flickering with black patches in Safari (the heart nudge animated a shadow; it now animates a ring that costs the browser nothing).'
            ]
        },
        {
            v: '3.4', date: '2026-09-14', items: [
                'Calmer first visit: no welcome form. New visitors start on Toronto leisure and figure skating, get the 20-second tour with a big Skip, and can turn Guides and Chats on in Settings whenever they like.',
                'Filters, redesigned: three main types with an obvious Ages button under each, the day and city chips, then a More section for age, ended sessions, saved-only and order. Selected chips are readable in dark mode again.',
                'Top bar now holds Refresh and the Paid switch. The third button is a List / Calendar switch, so it is always clear which view you are in and how to get back.',
                'Sessions read cleaner: fewer icons, plain "Map" and "toronto.ca" links, prices as price tags, notes that wrap, and alert text that is never cut off.',
                'The city pill is a picker: tap it to choose one or more cities, tap the x to go back to all. The map and rink list follow the same city choice.',
                'Rinks and map: your rinks sit in their own section at the top with a count, and any session card can add its rink to your list from the more menu.',
                'toronto.ca is the ground truth now: a City session that toronto.ca no longer lists is hidden instead of flagged, and sessions toronto.ca lists that the weekly export lacks are added. The counts live in the status line popover.',
                'Settings regrouped into Display, Learn and share, and Community, with one button style throughout. Modals dim the page without changing its colour.',
                'Type labels: Adapted is now Adaptive, and the leftover category is Ice Breakdancing.'
            ]
        },
        {
            v: '3.3', date: '2026-09-14', items: [
                '🏙️ Four more towns: Stouffville (Clippers Sports Complex + Stouffville Arena), Ajax (Community Centre), Oshawa\'s city arenas (Delpark Homes Centre, Donevan Recreation Complex) and Pickering (Chestnut Hill Developments Rec Complex, Don Beer Arena) — Pickering\'s public skates are free',
                '📄 Stouffville and Ajax publish their schedules as PDFs and Pickering as a web table, so those rows are marked unverified and drop the dates their towns list as cancelled; Oshawa comes from its booking system',
                '🏷️ Vaughan\'s note now says what the city says: fees are resident prices with a 20% non-resident surcharge — ask at the desk'
            ]
        },
        {
            v: '3.2', date: '2026-09-14', items: [
                '🧘 A calmer schedule: one search box, three buttons (Filters · Rinks & map · Week), your active filters as removable pills, and one quiet status line — instead of eight rows of controls',
                '🎛️ Filters that remember: pick Leisure → adult / older adult / child & family / youth, same for Hockey, Figure and the rest; choose cities (Toronto, Markham, Vaughan, Mississauga…), a day, your rinks, paid venues, and the order — all saved on this device',
                '🗺️ Rinks & map is one view now: use your current location or type an address, see the nearest rinks listed beside the map with distances and session counts, star the ones that are yours',
                '📅 Sessions are grouped under day headers (Today, Tomorrow, …) so rows carry less text',
                '🏙️ City labels everywhere, and Vaughan sessions say plainly that they are free for Vaughan residents only',
                '🧹 Cut: the vote button, the new-skater question, desktop notifications, the winter banner, the muted list in Settings, the version chip and name pill up top. What\'s new lives in Settings; the tab bar hides when only the schedule is on'
            ]
        },
        {
            v: '3.1', date: '2026-09-14', items: [
                '🔎 Live cross-check against toronto.ca: every City session in the next two weeks is now verified against that rink\'s LIVE schedule on toronto.ca. The City\'s weekly data export lags its live system — a Malvern "Leisure Skate" the City had dropped stayed listed for days and someone travelled for nothing. Dropped sessions are struck out with a red flag, and every City row links to its toronto.ca page so you can verify yourself',
                '📆 Add to calendar opens your calendar app: Google Calendar, Outlook, or an .ics for Apple — rink address, price and links pre-filled',
                '🌡️ Weather chip: tap it to pick a spot (Scarborough, North York, Markham, Mississauga…) or follow your 📍 location',
                '🗺️ Map button right in the schedule toolbar — pins, distances from your chosen spot, free scroll and pinch',
                '🛡️ Moderation is your choice: the third-party profanity check for public rooms and guides can be switched off in Settings (the on-device word list always runs). Public rooms say so above the message box; DMs and private groups never leave your device',
                '👻 Invisible mode now truly hides you — sending a message no longer flips you back to "online" for everyone else',
                '📱 Pull down to refresh in the installed / home-screen app',
                '💲 Paid-only rinks (e.g. Markham) no longer read "0 sessions" while Paid is off — pickers show "N paid", and picking such a rink turns Paid on for you',
                '🎟 Fixed the "-1 spots left" badge on Canlan sessions',
                '🏒 More rinks: Canlan Etobicoke, Scarborough, Oakville & Oshawa (paid public skates), and six more cities via their official feeds — Mississauga (10 arenas), Brampton (7), Oakville (7), Burlington (7), Vaughan (5, free!) and Richmond Hill\'s Ed Sackfield Arena. Markham no longer loses sessions to a booking-page quirk, shows the adult price instead of the family ticket, and all six Markham venues are on the map at their real coordinates',
                '▶️ New auto-playing 60-second guide with highlighted regions, next to the quick tour — Skip is always one tap away',
                '⚡ The site\'s own relay joins the pool alongside the public ones, gated by the same proof-of-work — chats and guides no longer depend on public relays alone'
            ]
        },
        {
            v: '3.0', date: '2026-08-04', items: [
                '🗺️ Interactive rink map — every rink as a pin, free scroll & pinch, distances from your 📍 spot, tap a pin for sessions/alerts/actions (find it via Near me)',
                '🏒 New city: Markham! Angus Glen drop-in skating (official booking data, prices & real age limits included) — more Markham venues are one config line away',
                '🌡️ Live temperature chip in the schedule header (feels-like included) so you dress right — follows your saved location',
                '🌳 Winter-ready: when the city\'s outdoor rinks come back (Nov–Apr), a banner appears and the map grows an Outdoor filter — it wakes up on its own',
                '💲 Shared sessions in chat now show a Paid badge with the exact price — nobody shows up surprised',
                '👻 Privacy: go Invisible (never listed as online) and switch DMs off entirely — both in Settings',
                '📱 QR code in Settings to beam the site to any phone; plus a replayable 20-second tour for newcomers (big Skip, promise)',
                '🔍 Fine print added: what gets checked by third-party moderation (public rooms only — DMs never leave your device) and data attributions'
            ]
        },
        {
            v: '2.9', date: '2026-08-04', items: [
                'Service alerts are now genuinely live on every open page: tabs, phones and installed bookmarks re-check every ~5 minutes AND the instant you come back to the app — no more "loaded this morning, blind all day"',
                'The alert checker runs twice as often (every 15 min) and stamps a heartbeat, so the site can tell "no alerts" apart from "checker is down"',
                'You can SEE alert freshness now: "· alerts 1:13 PM" next to the update stamp, and a loud warning banner if the feed hasn\'t checked in for hours',
                'Alert matching hardened against the city renaming categories (today\'s cancellation used a different label than July\'s did)'
            ]
        },
        {
            v: '2.8', date: '2026-07-17', items: [
                'Desktop no longer has a dead strip to the right of Chats — all three columns stretch to fill the window',
                'Short messages ("ok", "see you") now sit under the sender\'s name like every other message, not beside it',
                'Small chat consistency pass: nameless senders show as "Skater" instead of a lone dot, and the "new messages" pill clears the taller message box'
            ]
        },
        {
            v: '2.7', date: '2026-07-17', items: [
                'Phone chat fixes: tapping the message box no longer zooms the page (and crops the send arrow)',
                'The group name isn\'t covered by "#CODE • connected · N here now" anymore — status sits neatly under the title',
                'Busy rooms show 2 members + a "+N more" button instead of flooding the screen with name chips'
            ]
        },
        {
            v: '2.6', date: '2026-07-17', items: [
                'Theme defaults to Auto again — dark mode passed inspection 😎',
                'Fixed: sharing a session into a group chat now appears in YOUR chat instantly too (it was only visible to everyone else — classic missing local echo)',
                '"N paid hidden" is honest now: it respects every filter, so Hockey-only or a paid-free day shows no phantom hint (the Paid toggle hides too when it would do nothing)',
                'Cancelling the "refresh again?" prompt no longer claims anything was refreshed',
                'Share moved into the 📋 menu (one less icon per row) and only appears when Chats are enabled'
            ]
        },
        {
            v: '2.5', date: '2026-07-17', items: [
                'Dark mode got a real design: a "night rink" theme — deep ice-blue surfaces with actual depth, glowing cyan accents, calm chips, native dark controls and scrollbars',
                'The site now defaults to light; Auto (follow your device) and Dark are one tap away in Settings → Appearance',
                'Your phone\'s status bar / browser chrome now matches the theme'
            ]
        },
        {
            v: '2.4', date: '2026-07-17', items: [
                'Dark mode actually looks good now — titles, filter pills, tags and badges all re-tuned for contrast instead of glowing pastels',
                'New visitors start schedule-only: Guides & Chats are opt-in on the welcome screen (nothing connects to the network until you say so)',
                'Settings got a clear split: app preferences up top, community features boxed in an orange "powered by Nostr ⚡" card',
                'Rink pickers now show session counts — each location in My rinks says how many upcoming sessions it has, and "All rinks (N)" counts active locations (both follow the Paid toggle)',
                'Clearer words: "Calendar" instead of "Week", "Show past", and 📍 is back on "Near me"'
            ]
        },
        {
            v: '2.3', date: '2026-07-17', items: [
                'Cleaner look for every age: buttons say what they do in words (Refresh, List/Week, Near me…) instead of mystery icons',
                'Countdown card for your saved sessions — "starts in 2h 15m" ticks live at the top of the schedule; tap it to jump there',
                'Calendar legend now explains the colors and states in plain words',
                'Filters got smarter: empty categories (Speed, Ringette… until outdoor season) hide themselves; the Paid toggle only appears when your current rink view actually has paid sessions; Saved shows a live count',
                'Age picker spells out the ranges: Kids (≤12), Teens (13–17), Adults (18+), Seniors (60+)',
                'Dark mode moved into Settings as Auto / Light / Dark (follows your device on Auto)',
                'Vote button no longer vanishes without a group — it now explains how voting works',
                'Home-screen app polish: safe-area padding for notches, and the sort dropdown no longer gets cut off on phones'
            ]
        },
        {
            v: '2.2', date: '2026-07-17', items: [
                '🎟 LIVE spots-left on paid sessions (e.g. "197/200 spots" at Canlan York) — fetched straight from the venue\'s registration system every few minutes',
                '📲 Install as an app! Add to your home screen (CN-Tower-on-a-skate icon 😌) — the last-loaded schedule even works offline at the rink',
                '👶🧒🧑🧓 Age filter got quick picks: Kids / Teens / Adults / Seniors, plus an exact-age option',
                '🔎 Search now also matches street addresses and postal codes',
                '🚑 If the schedule data ever goes stale (auto-updater down) or a venue feed fails, a warning banner now says so instead of quietly showing old times',
                '🪶 Schedule-only setups (Guides & Chats hidden) now skip the chat network entirely — fewer connections, less data',
                '🧹 Fixed: setup-screen checkboxes were huge and squished their text off-centre; page title unified to "Toronto Skating"'
            ]
        },
        {
            v: '2.1', date: '2026-07-16', items: [
                '🏒→🚫 Ball hockey (a gym sport!) no longer clutters the ice-skating list',
                '🎨 Calendar sessions are now color-coded by type — same colors as the list badges (hockey red, figure blue, leisure green…)',
                '👤 Age labels make sense now: "Adults 19+", "Ages 8–12", "Up to 12" — and the age filter works on every row',
                '🪖 Moss Park Arena ℹ️ note: CSA-approved helmet mandatory, kids ≤7 accompanied by an adult',
                '👁️ Guides & Chats can be hidden — toggle them in ⚙️ Settings; new visitors get a one-time setup screen'
            ]
        },
        {
            v: '2.0', date: '2026-07-16', items: [
                '🚨 Live service alerts from toronto.ca — sessions at closed rinks are flagged, other alerts show a warning with the city\'s note',
                '🏒 New venues: Moss Park Arena (free public skate) and Canlan York (NFP Athletic Centre, $5 public skate)',
                '💰 Paid sessions toggle — hidden by default, gold-highlighted with the price when shown',
                '🗓️ Week calendar view — plan your week; saved sessions glow',
                '📍 Closest-rink finder — share location or type an address/postal code',
                '⭐ My rinks — pick your usual spots and filter everything to them',
                '⏱️ Times now follow Toronto time on any device; "Starts in 25m" / "On now · 40m left" chips; ended sessions auto-hide',
                '❓ Scraped schedules (Moss Park) are marked UNVERIFIED — call/check the website before heading out'
            ]
        },
        {
            v: '1.0', date: '2026-06-20', items: [
                'City drop-in schedule, guides, group chats & DMs, favourites, dark mode'
            ]
        }
    ],

    /* ---------- Top-level views (tabs + panels) ----------
       visKey = the SkateSettings boolean that shows/hides the section
       (Programs has none — the schedule is always on). */
    views: [
        { id: 'programs', label: 'Schedule' },
        { id: 'guides',   label: 'Guides', visKey: 'showGuides' },
        { id: 'chats',    label: 'Chats', badgeId: 'chats-badge', visKey: 'showChats' }
    ],

    // Settings → Sections toggle buttons (independent, not radio)
    sectionToggles: [
        { id: 'showGuides', seg: 'Guides' },
        { id: 'showChats',  seg: 'Chats' }
    ],

    // Settings → Privacy toggle buttons (nostr box). `on` = the settings
    // value that renders the button ACTIVE (invisible is opt-in true,
    // DMs are opt-out false).
    privacyToggles: [
        { id: 'invisible',        seg: 'Invisible',   on: true },
        { id: 'dmsAllowed',       seg: 'Allow DMs',   on: true, default: true },
        // third-party profanity APIs for PUBLIC rooms + guides (the on-device
        // word list is mandatory and always runs; private text never leaves)
        { id: 'remoteModeration', seg: 'Cloud filter', on: true, default: true }
    ],

    // Canonical URL the QR code + share links point at (location.href
    // would leak localhost/dev paths into shared codes).
    siteUrl: 'https://sunmoonron.github.io/skate/',

    // Alternate origin for the data JSONs (skating-programs, rinks, alerts,
    // live-check, meta): the home server refreshes them every 10 to 30
    // minutes (dell-nix modules/skate-data.nix) instead of GitHub's few
    // cron runs a day. SkateAPI falls back to the committed same-origin
    // copies on any failure (see api.js), so the GitHub cron stays the
    // safety net. null = committed copies only.
    dataBase: 'https://skate-data.ronishbhatt.com/projects/data',

    /* ---------- Weather chip spots (tap the chip to pick) ---------- */
    // 'auto' = your saved 📍 location when set, otherwise central Toronto.
    weatherSpots: [
        { id: 'toronto',      label: 'Downtown Toronto', lat: 43.6532, lng: -79.3832 },
        { id: 'scarborough',  label: 'Scarborough',      lat: 43.7764, lng: -79.2318 },
        { id: 'northyork',    label: 'North York',       lat: 43.7615, lng: -79.4111 },
        { id: 'etobicoke',    label: 'Etobicoke',        lat: 43.6205, lng: -79.5132 },
        { id: 'eastyork',     label: 'East York',        lat: 43.6913, lng: -79.3277 },
        { id: 'markham',      label: 'Markham',          lat: 43.8561, lng: -79.3370 },
        { id: 'vaughan',      label: 'Vaughan',          lat: 43.8372, lng: -79.5083 },
        { id: 'richmondhill', label: 'Richmond Hill',    lat: 43.8828, lng: -79.4403 },
        { id: 'mississauga',  label: 'Mississauga',      lat: 43.5890, lng: -79.6441 },
        { id: 'brampton',     label: 'Brampton',         lat: 43.7315, lng: -79.7624 },
        { id: 'pickering',    label: 'Pickering / Ajax', lat: 43.8384, lng: -79.0868 },
        { id: 'oshawa',       label: 'Oshawa',           lat: 43.8971, lng: -78.8658 },
        { id: 'oakville',     label: 'Oakville',         lat: 43.4675, lng: -79.6877 },
        { id: 'burlington',   label: 'Burlington',       lat: 43.3255, lng: -79.7990 }
    ],

    /* ---------- Quick tour (spotlight steps; missing/hidden targets auto-skip) ---------- */
    // `sec` = how long the auto-playing guide lingers on the step.
    tourSteps: [
        { sel: '#search-input',          title: 'Search',                text: 'Type a rink, a city or a session name. Results filter as you type.', sec: 4 },
        { sel: '#btn-filters',           title: 'Filters',               text: 'Leisure, figure and hockey with their age groups, a day, cities, your rinks and the order. Your picks are remembered on this device.', sec: 6 },
        { sel: '#active-filters',        title: 'Your active filters',   text: 'Each pill is one filter. Tap the x to remove it. Tap the city pill to pick other cities.', sec: 5 },
        { sel: '#btn-rinks',             title: 'Rinks and map',         text: 'Every rink on a map, with distances from your location or an address you type. Star the rinks that are yours.', sec: 6 },
        { sel: '#view-seg',              title: 'List or calendar',      text: 'The same sessions as a list or a week grid. In the grid, tap a day chip to jump, and tap a crowded time block to open that day as a list.', sec: 5 },
        { sel: '#btn-paid',              title: 'Paid venues',           text: 'Paid rinks are hidden until you switch this on. Prices then show on each session.', sec: 4 },
        { sel: '#btn-refresh',           title: 'Refresh',               text: 'Reloads the schedule, rink alerts and live spots. The status line under the buttons says when things were last checked.', sec: 5 },
        { sel: '#program-list .program-item', title: 'A session',        text: 'Time, rink, ages and price. Tap the rink name for directions; the page icon beside it opens the official rink page, the one the staff go by. The heart saves the session.', sec: 7 },
        { sel: '#program-list .btn-copy', title: 'More',                 text: 'Copy the details, add the session to your calendar, share it into a chat, or add this rink to your rinks.', sec: 5 },
        { sel: '#weather-chip',          title: 'Dress for it',          text: 'Live temperature. Tap it to pick a spot, from Scarborough to Mississauga.', sec: 4 },
        { sel: '#btn-settings',          title: 'Settings',              text: 'Theme, time format, sharing, the community sections and privacy. Enjoy the ice.', sec: 4 }
    ],


    /* ---------- Programs panel ---------- */
    // Filter chips. `keywords` drive the generic matcher; `special` ids get
    // custom handling ('all' = no filter, 'favorites' = saved list).
    // Age/audience sub-types inside each category (classified from the
    // session's title and age bounds — see P.subType in app.js). Order = UI order.
    subTypes: [
        { id: 'all',   label: 'All ages' },
        { id: 'child', label: 'Child & family' },
        { id: 'youth', label: 'Youth' },
        { id: 'adult', label: 'Adult' },
        { id: 'older', label: 'Older adult 55+' },
        { id: 'women', label: 'Women & girls' }
    ],
    // City order in the Filters sheet (anything else sorts after, A–Z).
    cityOrder: ['Toronto', 'Markham', 'Vaughan', 'Richmond Hill', 'Stouffville', 'Mississauga', 'Brampton', 'Oakville', 'Burlington', 'Pickering', 'Ajax', 'Oshawa'],

    // Activity categories (Filters → Type). The keyword matcher classifies
    // each session; sessions matching nothing fall into 'other'.
    programTypes: [
        // Leisure keywords cover every city's naming: Toronto "Leisure Skate",
        // Canlan/Brampton "Public Skate", Markham "Recreational Skate",
        // Oakville "Recreation Skate", Mississauga "Fun Skate" / "Adult &
        // Older Adult Skate", Vaughan "Skating - Unsupervised", Burlington
        // "Skate 19+" / "Sensory Skate", Richmond Hill "Public Skating".
        { id: 'leisure',   label: 'Leisure',   keywords: LEISURE_WORDS },
        { id: 'hockey',    label: 'Hockey',    keywords: ['shinny', 'hockey', 'stick'] },
        { id: 'figure',    label: 'Figure',    keywords: ['figure', 'ticket ice'] },
        { id: 'speed',     label: 'Speed',     keywords: ['speed'] },
        { id: 'adapted',   label: 'Adaptive',  keywords: ['adapted', 'adaptive'] },
        { id: 'ringette',  label: 'Ringette',  keywords: ['ringette'] },
        { id: 'other',     label: 'Ice Breakdancing', keywords: [] }   // everything that is none of the above
    ],

    // Activity → badge tag. First keyword hit wins (order matters).
    // `emoji` shows on the row badge only (the legend and pills stay plain).
    activityTags: [
        { keywords: ['shinny', 'hockey', 'stick'], cls: 'hockey',  label: 'Hockey',   emoji: '🏒' },
        { keywords: ['figure', 'ticket ice'],    cls: 'figure',   label: 'Figure',   emoji: '⛸️' },
        { keywords: ['speed'],                   cls: 'speed',    label: 'Speed',    emoji: '⛸️' },
        { keywords: LEISURE_WORDS,               cls: 'leisure',  label: 'Leisure',  emoji: '⛸️' },
        { keywords: ['adapted', 'adaptive'],     cls: 'adapted',  label: 'Adaptive', emoji: '♿' },
        { keywords: ['ringette'],                cls: 'ringette', label: 'Ringette', emoji: '🥏' }
    ],

    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],

    // Sort orders for the programs list. 'near' needs a saved location —
    // picking it without one opens the locator first. Labels stay short
    // so the select never truncates on narrow phones.
    sortOptions: [
        { id: 'time', label: 'Soonest', title: 'Order by start time' },
        { id: 'near', label: 'Nearest', title: 'Order by distance from your location' }
    ],

    // Appearance (Settings): Auto follows the device's light/dark preference.
    themes: [
        { id: 'system', seg: 'Auto' },
        { id: 'light',  seg: 'Light' },
        { id: 'dark',   seg: 'Dark' }
    ],

    /* ---------- Per-location footnotes (keyed by city Location ID) ---------- */
    // Shown as a tappable ℹ️ next to the location name.
    locationNotes: {
        '712': 'Don Montgomery has a live rink-info TV on site. The lobby screen shows today\'s actual ice times, worth a glance when you arrive.',
        '3491': 'Moss Park Arena: a CSA-approved helmet is mandatory for all public skaters, and kids 7 and under must be accompanied on the ice by an adult.'
    },

    /* ---------- Data-source hints (keyed by program.Source) ---------- */
    // `site` = the short name shown on the per-row "verify" link.
    sourceInfo: {
        'city':        { city: 'Toronto', label: 'City of Toronto', verified: true, site: 'toronto.ca' },
        'canlan-york': { city: 'Toronto', label: 'Canlan Sports (York)', verified: true, site: 'Canlan',
                         note: 'Third-party paid venue. Register on their site; sessions can sell out or change.' },
        'canlan-etobicoke':   { city: 'Toronto', label: 'Canlan Sports (Etobicoke)', verified: true, site: 'Canlan',
                         note: 'Third-party paid venue. Register on their site; sessions can sell out or change.' },
        'canlan-scarborough': { city: 'Toronto', label: 'Canlan Sports (Scarborough)', verified: true, site: 'Canlan',
                         note: 'Third-party paid venue. Register on their site; sessions can sell out or change.' },
        'canlan-oakville':    { city: 'Oakville', label: 'Canlan Sports (Oakville)', verified: true, site: 'Canlan',
                         note: 'Third-party paid venue. Register on their site; Senior Skate is listed at $0.' },
        'canlan-oshawa':      { city: 'Oshawa', label: 'Canlan Sports (Oshawa)', verified: true, site: 'Canlan',
                         note: 'Third-party paid venue. Register on their site; sessions can sell out or change.' },
        'markham':     { city: 'Markham', label: 'City of Markham', verified: true, site: 'markham.ca',
                         note: 'Official Markham booking data. Prices vary by age ($0 for some groups); most drop-ins open for booking 21 hours before the start.' },
        'vaughan':     { city: 'Vaughan', label: 'City of Vaughan', verified: true, site: 'vaughan.ca',
                         note: 'Official Vaughan booking data. Drop-in skating and shinny are free for Vaughan residents (proof of address). The city adds a 20% non-resident surcharge to its fees, so non-residents should ask at the desk. Ticket Ice figure skating $10.50.' },
        'richmondhill': { city: 'Richmond Hill', label: 'City of Richmond Hill', verified: true, site: 'richmondhill.ca',
                         note: 'Official Richmond Hill calendar (Ed Sackfield Arena). Adult $5.90 skate, $8.70 shinny, figure and stick and puck; tickets at the arena desk from 30 minutes before.' },
        'brampton':    { city: 'Brampton', label: 'City of Brampton', verified: true, site: 'brampton.ca',
                         note: 'Official Brampton booking data. Adult $2.96 plus tax, child and youth $2.15, residents 65 and over free; registration opens 25 hours ahead for residents.' },
        'oakville':    { city: 'Oakville', label: 'Town of Oakville', verified: true, site: 'oakville.ca',
                         note: 'Official Oakville booking data. Adult $5.38, child, youth and 65 plus $4.31 (plus tax); members $0.' },
        'burlington':  { city: 'Burlington', label: 'City of Burlington', verified: true, site: 'burlington.ca',
                         note: 'Official Burlington booking data. Flat $3.50 per skate; pass holders $0.' },
        'mississauga': { city: 'Mississauga', label: 'City of Mississauga', verified: true, site: 'mississauga.ca',
                         note: 'Official Mississauga drop-in calendar. Adult $5.21, child, youth and 55 plus $4.17 including tax (by-law rates, tickets at the door 30 minutes before); residents 65 and over and kids 3 and under free.' },
        'mosspark':    { city: 'Toronto', label: 'mossparkarena.com', verified: false, site: 'mossparkarena.com',
                         note: 'Schedule read from their website. There is no live feed for this arena.' },
        'stouffville': { city: 'Stouffville', label: 'Whitchurch-Stouffville', verified: false, site: 'townofws.ca',
                         note: 'Weekly schedule read from the Town\'s drop-in PDF, no live feed. Adult $5.50 skate, $7.50 shinny and stick and puck, youth and 60 plus less; cash, debit or credit at the door.' },
        'ajax':        { city: 'Ajax', label: 'Town of Ajax', verified: false, site: 'ajax.ca',
                         note: 'Weekly schedule read from the Town\'s skating PDF, no live feed. Adult $5.25 skate, $7.90 shinny; youth and 65 plus $3.50 and $5.65. Check ajax.ca/skating for cancellations.' },
        'oshawa':      { city: 'Oshawa', label: 'City of Oshawa', verified: true, site: 'oshawa.ca',
                         note: 'Official Oshawa booking data (activeOshawa). Adult $5.25 skate, $8.50 shinny, child and youth $3.50, family $10.75; pay at the desk, drop in only.' },
        'pickering':   { city: 'Pickering', label: 'City of Pickering', verified: false, site: 'pickering.ca',
                         note: 'Weekly schedule read from pickering.ca, no live feed. Public skating is free at both arenas; the cancellation dates the City lists are already removed.' }
    },

    // Per-program action buttons, in render order. Share lives inside the
    // 📋 popover now (and only when Chats are enabled) — one less mystery
    // icon on every row.
    programActions: [
        { act: 'fav',   cls: 'btn-favorite' },
        { act: 'copy',  cls: 'btn-copy', title: 'More: copy, calendar, share, add this rink to your rinks', text: '⋯' }
    ],

    /* ---------- Chats panel ---------- */
    chatFilters: [
        { id: 'all',    label: 'All' },
        { id: 'groups', label: 'Groups', badgeId: 'cf-groups-badge' },
        { id: 'dms',    label: 'DMs',    badgeId: 'cf-dms-badge' },
        { id: 'muted',  label: 'Muted',  chipId: 'cf-muted', dynamic: true }
    ],

    // Default public rooms. autoJoin rooms are seeded once on first run
    // (leaving one later is respected — seeding never repeats).
    rooms: {
        general: { name: 'General Chat',    passphrase: 'toronto-skating-general-public-2025', emoji: '💬', desc: 'Help, tips & chill',            autoJoin: true, defaultActive: true },
        leisure: { name: 'Leisure Skating', passphrase: 'toronto-leisure-skate-public-2025',   emoji: '⛸️', desc: 'Casual skating & fun',          autoJoin: true },
        shinny:  { name: 'Shinny Hockey',   passphrase: 'toronto-shinny-hockey-public-2025',   emoji: '🏒', desc: 'Drop-in hockey games',          autoJoin: true },
        figure:  { name: 'Figure Skating',  passphrase: 'toronto-figure-skate-public-2025',    emoji: '⛸️', desc: 'Spins, jumps & grace',          autoJoin: true },
        newbies: { name: 'New Skaters',     passphrase: 'toronto-new-skaters-public-2026',     emoji: '🐣', desc: 'First laps, zero judgement',    autoJoin: true }
    },

    // Random identity name pools.
    identity: {
        adjectives: ['Swift', 'Gliding', 'Frozen', 'Quick', 'Cool', 'Icy', 'Smooth', 'Fast', 'Chill', 'Frosty'],
        nouns: ['Skater', 'Penguin', 'Blade', 'Tiger', 'Bear', 'Fox', 'Wolf', 'Hawk', 'Star', 'Flash']
    },

    /* ---------- Guides panel ---------- */
    guideCategories: {
        start:     { name: 'Getting started',   emoji: '🐣' },
        gear:      { name: 'Gear & equipment',  emoji: '🛼' },
        rinks:     { name: 'Rinks & locations', emoji: '🏟️' },
        technique: { name: 'Technique',         emoji: '🌀' },
        etiquette: { name: 'Ice etiquette',     emoji: '🤝' },
        site:      { name: 'Using this site',   emoji: '🧭' },
        bugs:      { name: 'Bug reports',       emoji: '🐛' },
        ideas:     { name: 'Suggestions',       emoji: '💡' }
    },

    /* ---------- Settings segments ---------- */
    timeFormats: [
        { id: '12h', label: '12h · 2:30 PM' },
        { id: '24h', label: '24h · 14:30' }
    ],

    /* ---------- Context-menu action labels ----------
       Menus in app.js are ordered lists of these action ids; labels live
       here so wording is data, availability/handlers stay in code. */
    actions: {
        reply:        { label: 'Reply' },
        copyText:     { label: 'Copy text' },
        openProgram:  { label: 'Open in the schedule' },
        openGuide:    { label: 'Open guide' },
        retry:        { label: 'Retry send' },
        message:      { label: 'Message {name}' },
        mute:         { label: 'Mute {name}', danger: true },
        unmute:       { label: 'Unmute {name}' },
        copyInvite:   { label: 'Copy invite link' },
        rename:       { label: 'Rename group' },
        clearHistory: { label: 'Clear history on this device' },
        leaveGroup:   { label: 'Leave group', danger: true },
        leaveRoom:    { label: 'Leave room',  danger: true },
        deleteThread: { label: 'Delete conversation', danger: true },
        copyDetails:  { label: 'Copy details' },
        copyLink:     { label: 'Copy link' },
        addCalendar:  { label: 'Add to calendar' },
        calGoogle:    { label: 'Google Calendar ↗' },
        calOutlook:   { label: 'Outlook.com ↗' },
        calIcs:       { label: 'Apple or other (.ics file)' },
        openOfficial: { label: 'Verify on {site} ↗' },
        addRink:      { label: 'Add {rink} to my rinks' },
        removeRink:   { label: 'Remove {rink} from my rinks' },
        shareChat:    { label: 'Share to chat' }
    },

    /* ---------- Hash routes (#p=…, #guide=…, invite fallback) ---------- */
    routes: [
        { prefix: 'p=',     action: 'focusProgram' },
        { prefix: 'guide=', action: 'openGuide' },
        { fallback: true,   action: 'invite' }
    ]
};

if (typeof module !== 'undefined') module.exports = window.SkateConfig;
