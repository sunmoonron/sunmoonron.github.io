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

    /* ---------- Top-level views (tabs + panels) ---------- */
    views: [
        { id: 'programs', label: '⛸️ Programs' },
        { id: 'guides',   label: '📖 Guides' },
        { id: 'chats',    label: '💬 Chats', badgeId: 'chats-badge' }
    ],

    /* ---------- Programs panel ---------- */
    // Filter chips. `keywords` drive the generic matcher; `special` ids get
    // custom handling ('all' = no filter, 'favorites' = saved list).
    programTypes: [
        { id: 'all',       label: 'All',       special: 'all' },
        { id: 'favorites', label: '❤️ Saved',  special: 'favorites' },
        { id: 'leisure',   label: 'Leisure',   keywords: ['leisure'] },
        { id: 'hockey',    label: 'Hockey',    keywords: ['shinny', 'hockey'] },
        { id: 'figure',    label: 'Figure',    keywords: ['figure'] },
        { id: 'speed',     label: 'Speed',     keywords: ['speed'] },
        { id: 'adapted',   label: 'Adapted',   keywords: ['adapted'] },
        { id: 'ringette',  label: 'Ringette',  keywords: ['ringette'] }
    ],

    // Activity → badge tag. First keyword hit wins (order matters).
    activityTags: [
        { keywords: ['shinny', 'hockey'], cls: 'hockey',   label: '🏒 Hockey' },
        { keywords: ['figure'],           cls: 'figure',   label: '⛸️ Figure' },
        { keywords: ['speed'],            cls: 'speed',    label: '⛸️ Speed' },
        { keywords: ['leisure'],          cls: 'leisure',  label: '⛸️ Leisure' },
        { keywords: ['adapted'],          cls: 'adapted',  label: '♿ Adapted' },
        { keywords: ['ringette'],         cls: 'ringette', label: '🥏 Ringette' }
    ],

    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],

    // Per-program action buttons, in render order. `gated:'activeGroup'`
    // means the button only renders while a group chat is active.
    programActions: [
        { act: 'fav',   cls: 'btn-favorite' },
        { act: 'copy',  cls: 'btn-copy',          title: 'Copy, link or add to calendar', text: '📋' },
        { act: 'share', cls: 'btn-share-program', title: 'Share to a group or DM',        text: '📤' },
        { act: 'vote',  cls: 'btn-vote', gated: 'activeGroup' }
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
