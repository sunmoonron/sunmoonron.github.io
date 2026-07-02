/**
 * SkateGuides — community guides for new skaters, on Nostr.
 *
 * Data model (every kind below verified stored on damus/nos.lol/primal):
 *   - Guide       kind 30023 (long-form, replaceable) — author can edit;
 *                 tags: ['d', slug], ['t','tskate-guide'], ['t', category], ['title', ...]
 *   - Upvote      kind 7 '+' with ['e', guideId] and ['a', address] — requires 16-bit PoW
 *   - Comment     kind 1111 with ['e', guideId] — requires 12-bit PoW
 *   - Pins        kind 30001 list ['d','tskate-pins'] signed by the SITE OWNER
 *   - Mutes       kind 30000 list ['d','tskate-mutes'] signed by the SITE OWNER
 *                 (muted event ids and pubkeys are hidden client-side)
 *
 * Anti brand-swarm ("buy XYZ boots" + 9999 farmed upvotes):
 *   1. Votes below the PoW threshold are IGNORED — not down-weighted, ignored.
 *      Farming 9999 votes costs 9999 x ~1-2s of real CPU per throwaway key.
 *   2. One counted vote per pubkey per guide.
 *   3. The owner's mute list nukes determined offenders (their guides, votes
 *      and comments all vanish for every visitor).
 *   4. Guides are plaintext + public by design so new visitors can read them
 *      before joining anything — moderation therefore can't stop other Nostr
 *      clients from seeing raw events, but it fully controls what THIS site shows.
 */
const SkateGuides = (() => {
    'use strict';

    // TODO(owner): put YOUR pubkey here (hex, not npub — decode with NostrTools.nip19.decode)
    // Pins + mutes signed by any other key are ignored.
    const OWNER_PUBKEY = 'REPLACE_WITH_OWNER_HEX_PUBKEY';

    const TAG = 'tskate-guide';
    const CATEGORIES = {
        start:     { name: 'Getting started', emoji: '🐣' },
        gear:      { name: 'Gear & equipment', emoji: '🛼' },
        rinks:     { name: 'Rinks & locations', emoji: '🏟️' },
        technique: { name: 'Technique', emoji: '🌀' },
        etiquette: { name: 'Ice etiquette', emoji: '🤝' },
        site:      { name: 'Using this site', emoji: '🧭' }
    };

    const state = {
        guides: {},      // guideId -> { id, address, slug, title, category, body, author, ts, votes:Set(pubkey), comments:[] }
        pins: [],        // ordered guide ids / addresses from owner's pin list
        mutedIds: new Set(),
        mutedPubkeys: new Set(),
        loaded: false,
        callbacks: []
    };

    function notify() {
        state.callbacks.forEach(cb => { try { cb(); } catch {} });
    }
    function onUpdate(cb) { state.callbacks.push(cb); }

    function tagVal(event, name) { return (event.tags || []).find(t => t[0] === name)?.[1] || null; }
    function tagVals(event, name) { return (event.tags || []).filter(t => t[0] === name).map(t => t[1]); }
    function address(event) { return `30023:${event.pubkey}:${tagVal(event, 'd') || ''}`; }

    function visible(guide) {
        return !state.mutedIds.has(guide.id) && !state.mutedPubkeys.has(guide.author);
    }

    // ---------- Incoming ----------
    function handleGuide(event) {
        if (!tagVals(event, 't').includes(TAG)) return;
        const addr = address(event);
        const existing = Object.values(state.guides).find(g => g.address === addr);
        if (existing && existing.ts >= event.created_at * 1000) return; // replaceable: keep newest
        if (existing) delete state.guides[existing.id];

        const category = tagVals(event, 't').find(t => CATEGORIES[t]) || 'start';
        state.guides[event.id] = {
            id: event.id, address: addr,
            slug: tagVal(event, 'd') || event.id.slice(0, 8),
            title: (tagVal(event, 'title') || 'Untitled guide').slice(0, 80),
            category,
            body: (event.content || '').slice(0, 6000),
            author: event.pubkey,
            authorName: (tagVal(event, 'client') || '').slice(0, 24) || null,
            ts: event.created_at * 1000,
            votes: existing?.votes || new Set(),
            comments: existing?.comments || []
        };
        notify();
    }

    function handleVote(event) {
        if (SkateMod.eventPow(event) < SkateMod.POW.vote) return;   // farmed cheap votes: ignored
        if (state.mutedPubkeys.has(event.pubkey)) return;
        if (event.content && event.content !== '+') return;          // only upvotes
        const target = tagVal(event, 'e');
        const guide = target && state.guides[target];
        if (guide) { guide.votes.add(event.pubkey); notify(); }
    }

    function handleComment(event) {
        if (SkateMod.eventPow(event) < SkateMod.POW.comment) return;
        if (state.mutedIds.has(event.id) || state.mutedPubkeys.has(event.pubkey)) return;
        const target = tagVal(event, 'e');
        const guide = target && state.guides[target];
        if (!guide || guide.comments.some(c => c.id === event.id)) return;
        guide.comments.push({
            id: event.id,
            text: SkateMod.clean((event.content || '').slice(0, 500)),
            author: event.pubkey,
            authorName: (tagVal(event, 'client') || 'Skater').slice(0, 24),
            ts: event.created_at * 1000
        });
        guide.comments.sort((a, b) => a.ts - b.ts);
        notify();
    }

    function handleOwnerList(event) {
        if (event.pubkey !== OWNER_PUBKEY) return;
        const d = tagVal(event, 'd');
        if (d === 'tskate-pins') {
            state.pins = tagVals(event, 'e').concat(tagVals(event, 'a'));
        } else if (d === 'tskate-mutes') {
            state.mutedIds = new Set(tagVals(event, 'e'));
            state.mutedPubkeys = new Set(tagVals(event, 'p'));
        }
        notify();
    }

    // ---------- Load ----------
    function load() {
        const since = Math.floor(Date.now() / 1000) - 180 * 86400;
        const filters = [
            { kinds: [30023], '#t': [TAG], since, limit: 100 }
        ];
        if (/^[0-9a-f]{64}$/.test(OWNER_PUBKEY)) {
            filters.push({ kinds: [30000, 30001], authors: [OWNER_PUBKEY] });
        }
        SkateNostr.sub('skate-guides', filters, (event) => {
            if (event.kind === 30023) handleGuide(event);
            else handleOwnerList(event);
        }, () => {
            state.loaded = true;
            subInteractions();
            notify();
        });
    }

    let interactionsSubbed = false;
    function subInteractions() {
        const ids = Object.keys(state.guides);
        if (!ids.length) return;
        interactionsSubbed = true;
        SkateNostr.sub('skate-guide-io', [
            { kinds: [7], '#e': ids.slice(0, 100) },
            { kinds: [1111], '#e': ids.slice(0, 100) }
        ], (event) => {
            if (event.kind === 7) handleVote(event);
            else handleComment(event);
        });
    }

    // ---------- Write paths ----------
    async function postGuide({ title, category, body }, identity) {
        title = (title || '').trim().slice(0, 80);
        body = (body || '').trim().slice(0, 6000);
        if (!title || body.length < 40) throw new Error('Give it a title and at least a few sentences');
        if (!CATEGORIES[category]) category = 'start';

        const verdict = await SkateMod.check(title + '\n' + body);
        if (!verdict.ok) throw new Error('That content won\'t fly here — keep it friendly');

        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'guide';
        const template = {
            kind: 30023,
            content: body,
            tags: [
                ['d', slug], ['t', TAG], ['t', category],
                ['title', title], ['client', identity.name || 'Skater'],
                ['published_at', String(Math.floor(Date.now() / 1000))]
            ],
            created_at: Math.floor(Date.now() / 1000)
        };
        const mined = await SkateMod.mine({ ...template, pubkey: identity.pk }, SkateMod.POW.guide);
        const event = NostrTools.finalizeEvent(mined, identity.sk);
        const ok = await SkateNostr.publish(event);
        if (ok) handleGuide(event);
        return ok;
    }

    async function vote(guideId, identity) {
        const guide = state.guides[guideId];
        if (!guide) return false;
        if (guide.votes.has(identity.pk)) return true; // already counted
        const template = {
            kind: 7, content: '+',
            tags: [['e', guideId], ['a', guide.address], ['p', guide.author], ['k', '30023']],
            created_at: Math.floor(Date.now() / 1000)
        };
        const mined = await SkateMod.mine({ ...template, pubkey: identity.pk }, SkateMod.POW.vote);
        const event = NostrTools.finalizeEvent(mined, identity.sk);
        const ok = await SkateNostr.publish(event);
        if (ok) { guide.votes.add(identity.pk); notify(); }
        return ok;
    }

    async function comment(guideId, text, identity) {
        const guide = state.guides[guideId];
        text = (text || '').trim().slice(0, 500);
        if (!guide || !text) return false;
        const verdict = await SkateMod.check(text);
        if (!verdict.ok) throw new Error('That comment won\'t fly here');
        const template = {
            kind: 1111, content: text,
            tags: [['e', guideId], ['a', guide.address], ['p', guide.author], ['k', '30023'], ['client', identity.name || 'Skater']],
            created_at: Math.floor(Date.now() / 1000)
        };
        const mined = await SkateMod.mine({ ...template, pubkey: identity.pk }, SkateMod.POW.comment);
        const event = NostrTools.finalizeEvent(mined, identity.sk);
        const ok = await SkateNostr.publish(event);
        if (ok) handleComment(event);
        return ok;
    }

    // ---------- Read surface ----------
    function list(category = null) {
        const pinsIndex = (g) => {
            const i = state.pins.indexOf(g.id);
            const j = state.pins.indexOf(g.address);
            return i > -1 ? i : (j > -1 ? j : -1);
        };
        return Object.values(state.guides)
            .filter(visible)
            .filter(g => !category || g.category === category)
            .sort((a, b) => {
                const pa = pinsIndex(a), pb = pinsIndex(b);
                if (pa > -1 || pb > -1) {
                    if (pa === -1) return 1;
                    if (pb === -1) return -1;
                    return pa - pb;
                }
                return (b.votes.size - a.votes.size) || (b.ts - a.ts);
            })
            .map(g => ({ ...g, votes: g.votes.size, pinned: pinsIndex(g) > -1 }));
    }

    function get(id) {
        const g = state.guides[id];
        return g && visible(g) ? { ...g, votes: g.votes.size, pinned: state.pins.includes(g.id) || state.pins.includes(g.address) } : null;
    }

    function hasVoted(id, pubkey) { return !!state.guides[id]?.votes.has(pubkey); }

    return { load, list, get, postGuide, vote, comment, hasVoted, onUpdate, CATEGORIES, OWNER_PUBKEY, get loaded() { return state.loaded; } };
})();

if (typeof module !== 'undefined') module.exports = SkateGuides;
