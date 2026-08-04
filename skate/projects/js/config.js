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
window.SkateConfig = {

    /* ---------- Release info (powers the version chip + What's new) ---------- */
    version: '2.9',
    changelog: [
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
        { id: 'programs', label: '⛸️ Schedule' },
        { id: 'guides',   label: '📖 Guides', visKey: 'showGuides' },
        { id: 'chats',    label: '💬 Chats', badgeId: 'chats-badge', visKey: 'showChats' }
    ],

    // Settings → Sections toggle buttons (independent, not radio)
    sectionToggles: [
        { id: 'showGuides', seg: '📖 Guides' },
        { id: 'showChats',  seg: '💬 Chats' }
    ],

    /* ---------- Programs panel ---------- */
    // Filter chips. `keywords` drive the generic matcher; `special` ids get
    // custom handling ('all' = no filter, 'favorites' = saved list).
    programTypes: [
        { id: 'all',       label: 'All',       special: 'all' },
        // 'favorites' renders as the ♥-styled chip with a live count
        { id: 'favorites', label: 'Saved',     special: 'favorites' },
        { id: 'leisure',   label: 'Leisure',   keywords: ['leisure', 'public skat'] },
        { id: 'hockey',    label: 'Hockey',    keywords: ['shinny', 'hockey'] },
        { id: 'figure',    label: 'Figure',    keywords: ['figure'] },
        { id: 'speed',     label: 'Speed',     keywords: ['speed'] },
        { id: 'adapted',   label: 'Adapted',   keywords: ['adapted'] },
        { id: 'ringette',  label: 'Ringette',  keywords: ['ringette'] }
    ],

    // Activity → badge tag. First keyword hit wins (order matters).
    activityTags: [
        { keywords: ['shinny', 'hockey'],        cls: 'hockey',   label: '🏒 Hockey' },
        { keywords: ['figure'],                  cls: 'figure',   label: '⛸️ Figure' },
        { keywords: ['speed'],                   cls: 'speed',    label: '⛸️ Speed' },
        { keywords: ['leisure', 'public skat'],  cls: 'leisure',  label: '⛸️ Leisure' },
        { keywords: ['adapted'],                 cls: 'adapted',  label: '♿ Adapted' },
        { keywords: ['ringette'],                cls: 'ringette', label: '🥏 Ringette' }
    ],

    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],

    // Sort orders for the programs list. 'near' needs a saved location —
    // picking it without one opens the locator first. Labels stay short
    // so the select never truncates on narrow phones.
    sortOptions: [
        { id: 'time', label: 'Soonest', title: 'Order by start time' },
        { id: 'near', label: 'Nearest', title: 'Order by distance from your location' }
    ],

    // Age quick-picks. Each preset filters with a representative age
    // (a 30-year-old can't join a 60+ session, a kid preset must clear
    // "6+" minimums, etc). 'exact' reveals the precise-age input.
    agePresets: [
        { id: '',      label: 'Any age' },
        { id: '8',     label: 'Kids (≤12)' },
        { id: '15',    label: 'Teens (13–17)' },
        { id: '30',    label: 'Adults (18+)' },
        { id: '65',    label: 'Seniors (60+)' },
        { id: 'exact', label: 'Exact age…' }
    ],

    // Rink scope segmented control (personalization). 'mine' filters every
    // list/calendar/search to the user's picked rinks.
    rinkScopes: [
        { id: 'all',  label: 'All rinks' },
        { id: 'mine', label: 'My rinks' }
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
        '712': 'Don Montgomery has a live rink-info TV on site — the lobby screen shows today\'s actual ice times, worth a glance when you arrive.',
        '3491': 'Moss Park Arena: a CSA-approved helmet is MANDATORY for all public skaters, and kids 7 and under must be accompanied on the ice by an adult.'
    },

    /* ---------- Data-source hints (keyed by program.Source) ---------- */
    sourceInfo: {
        'city':        { label: 'City of Toronto', verified: true },
        'canlan-york': { label: 'Canlan Sports (York)', verified: true,
                         note: 'Third-party paid venue — register on their site; sessions can sell out or change.' },
        'mosspark':    { label: 'mossparkarena.com', verified: false,
                         note: 'Schedule scraped from their website — there is NO live feed for this arena.' }
    },

    // Per-program action buttons, in render order. Share lives inside the
    // 📋 popover now (and only when Chats are enabled) — one less mystery
    // icon on every row.
    programActions: [
        { act: 'fav',   cls: 'btn-favorite' },
        { act: 'copy',  cls: 'btn-copy', title: 'Copy, share or add to calendar', text: '📋' },
        { act: 'vote',  cls: 'btn-vote' }
    ],

    /* ---------- Chats panel ---------- */
    chatFilters: [
        { id: 'all',    label: 'All' },
        { id: 'groups', label: '👥 Groups', badgeId: 'cf-groups-badge' },
        { id: 'dms',    label: '💬 DMs',    badgeId: 'cf-dms-badge' },
        { id: 'muted',  label: '🔇 Muted',  chipId: 'cf-muted', dynamic: true }
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

    /* ---------- Onboarding / settings segments ---------- */
    experiences: [
        { id: 'new',     seg: '🐣 New skater', emoji: '🐣', title: 'New to skating',
          sub: 'Show me guides, beginner-friendly sessions & the New Skaters room' },
        { id: 'regular', seg: '🏒 Regular',    emoji: '🏒', title: 'I skate regularly',
          sub: "Straight to the schedule — I know what I'm looking for" }
    ],
    timeFormats: [
        { id: '12h', label: '12h · 2:30 PM' },
        { id: '24h', label: '24h · 14:30' }
    ],

    /* ---------- Context-menu action labels ----------
       Menus in app.js are ordered lists of these action ids; labels live
       here so wording is data, availability/handlers stay in code. */
    actions: {
        reply:        { label: '↩ Reply' },
        copyText:     { label: '📋 Copy text' },
        openProgram:  { label: '⛸️ Open in Programs' },
        openGuide:    { label: '📖 Open guide' },
        retry:        { label: '🔁 Retry send' },
        message:      { label: '💬 Message {name}' },
        mute:         { label: '🔇 Mute {name}', danger: true },
        unmute:       { label: '🔊 Unmute {name}' },
        copyInvite:   { label: '🔗 Copy invite link' },
        rename:       { label: '✏️ Rename group' },
        clearHistory: { label: '🧹 Clear history (this device)' },
        leaveGroup:   { label: '🚪 Leave group', danger: true },
        leaveRoom:    { label: '🚪 Leave room',  danger: true },
        deleteThread: { label: '🗑 Delete conversation', danger: true },
        copyDetails:  { label: '📋 Copy details' },
        copyLink:     { label: '🔗 Copy link' },
        addCalendar:  { label: '📆 Add to calendar (.ics)' }
    },

    /* ---------- Hash routes (#p=…, #guide=…, invite fallback) ---------- */
    routes: [
        { prefix: 'p=',     action: 'focusProgram' },
        { prefix: 'guide=', action: 'openGuide' },
        { fallback: true,   action: 'invite' }
    ]
};

if (typeof module !== 'undefined') module.exports = window.SkateConfig;
