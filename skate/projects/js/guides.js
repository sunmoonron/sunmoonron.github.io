/**
 * SkateGuides v2 — community guides on Nostr, now with honest vote counts.
 *
 * Data model (verified stored on damus/nos.lol/primal):
 *   - Guide       kind 30023 (long-form, replaceable) — author can edit;
 *                 tags: ['d', slug], ['t','tskate-guide'], ['t', category], ['title', ...]
 *   - Reaction    kind 7 with ['e', targetId] — content '+' = vote, '-' = retraction.
 *                 THE FIX: v1 only ever counted '+', so a retracted vote stayed
 *                 counted forever for every new visitor. v2 keeps the LATEST
 *                 reaction per (pubkey, target); only pubkeys whose latest is
 *                 '+' count. Retractions replicate to fresh browsers correctly.
 *                 (kind-5 deletions were considered but relays honor them
 *                 inconsistently; latest-wins needs no relay cooperation.)
 *                 Works on comments too → comment upvotes.
 *   - Comment     kind 1111 with ['e', guideId] as root. A REPLY adds a second
 *                 ['e', parentCommentId] — replies still tag the guide root, so
 *                 one subscription filter catches the whole tree.
 *   - Pins        kind 30001 list ['d','tskate-pins'] signed by the SITE OWNER
 *   - Mutes       kind 30000 list ['d','tskate-mutes'] signed by the SITE OWNER
 *
 * Also new in v2:
 *   - Categories for 🐛 bug reports and 💡 suggestions (site feedback lives
 *     where the community already reads).
 *   - Interactions re-subscribe when new guides/comments arrive after EOSE —
 *     v1 only subscribed once, so votes on fresh guides were invisible until
 *     a full reload.
 *
 * Anti brand-swarm unchanged: reactions below the PoW threshold are ignored,
 * one counted vote per pubkey, owner mute list hides offenders client-side.
 */
const SkateGuides = (() => {
    'use strict';

    // TODO(owner): put YOUR pubkey here (hex, not npub — decode with NostrTools.nip19.decode)
    const OWNER_PUBKEY = 'a685bc7d6cf040b05d7c028407f21a5acf27f0e8bff7feb481d80975aeb27257';

    const TAG = 'tskate-guide';
    // Categories come from the central SkateConfig when present; the inline
    // fallback keeps this module self-contained.
    const CATEGORIES = (typeof window !== 'undefined' && window.SkateConfig?.guideCategories) || {
        start:     { name: 'Getting started', emoji: '🐣' },
        gear:      { name: 'Gear & equipment', emoji: '🛼' },
        rinks:     { name: 'Rinks & locations', emoji: '🏟️' },
        technique: { name: 'Technique', emoji: '🌀' },
        etiquette: { name: 'Ice etiquette', emoji: '🤝' },
        site:      { name: 'Using this site', emoji: '🧭' },
        bugs:      { name: 'Bug reports', emoji: '🐛' },
        ideas:     { name: 'Suggestions', emoji: '💡' }
    };

    const state = {
        guides: {},          // guideId -> guide (see handleGuide)
        commentIndex: {},    // commentId -> guideId (for reaction routing)
        pins: [],
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

    // ---------- Reactions: latest-per-pubkey wins ----------
    // reactions: { pubkey: { up: bool, ts: seconds } }
    function applyReaction(reactions, pubkey, up, ts) {
        const prev = reactions[pubkey];
        if (prev) {
            if (prev.ts > ts) return false;            // stale — an older reaction arrived late
            // Equal timestamps happen for legacy +/- pairs that were mined
            // within the same wall-clock second (nostr-tools' minePow used to
            // rewrite created_at — see SkateMod.mine). Deterministic rule so
            // every client converges: the retraction wins the tie.
            if (prev.ts === ts && up) return false;
        }
        reactions[pubkey] = { up, ts };
        return true;
    }
    function countUp(reactions) {
        return Object.values(reactions || {}).filter(r => r.up).length;
    }
    function myVote(reactions, pubkey) {
        return !!reactions?.[pubkey]?.up;
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
            reactions: existing?.reactions || {},
            comments: existing?.comments || []
        };
        // keep the comment index pointing at the new (edited) guide id
        (state.guides[event.id].comments || []).forEach(c => { state.commentIndex[c.id] = event.id; });
        if (state.loaded) scheduleResub();
        notify();
    }

    function handleReaction(event) {
        if (SkateMod.eventPow(event) < SkateMod.POW.vote) return;   // farmed cheap votes: ignored
        if (state.mutedPubkeys.has(event.pubkey)) return;
        const content = (event.content || '').trim();
        if (content !== '+' && content !== '-') return;              // only vote / retract
        const up = content === '+';
        const target = tagVal(event, 'e');
        if (!target) return;

        const guide = state.guides[target];
        if (guide) {
            if (applyReaction(guide.reactions, event.pubkey, up, event.created_at)) notify();
            return;
        }
        const parentGuideId = state.commentIndex[target];
        const comment = parentGuideId && state.guides[parentGuideId]?.comments.find(c => c.id === target);
        if (comment) {
            if (applyReaction(comment.reactions, event.pubkey, up, event.created_at)) notify();
        }
    }

    function handleComment(event) {
        if (SkateMod.eventPow(event) < SkateMod.POW.comment) return;
        if (state.mutedIds.has(event.id) || state.mutedPubkeys.has(event.pubkey)) return;
        const eTags = tagVals(event, 'e');
        if (!eTags.length) return;
        // root = the guide; a second, different e-tag marks this as a reply
        const guide = eTags.map(id => state.guides[id]).find(Boolean);
        if (!guide || guide.comments.some(c => c.id === event.id)) return;
        const parentId = eTags.find(id => id !== guide.id && state.commentIndex[id] === guide.id) || null;

        guide.comments.push({
            id: event.id,
            parentId,
            text: SkateMod.clean((event.content || '').slice(0, 500)),
            author: event.pubkey,
            authorName: (tagVal(event, 'client') || 'Skater').slice(0, 24),
            ts: event.created_at * 1000,
            reactions: {}
        });
        guide.comments.sort((a, b) => a.ts - b.ts);
        state.commentIndex[event.id] = guide.id;
        if (state.loaded) scheduleResub();
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

    // Re-issue the interactions sub whenever the set of ids changes — a guide
    // or comment posted after EOSE gets its votes/replies live, not on reload.
    let lastSubKey = '';
    let resubTimer = null;
    function scheduleResub() {
        if (resubTimer) return;
        resubTimer = setTimeout(() => { resubTimer = null; subInteractions(); }, 1200);
    }
    function subInteractions() {
        const guideIds = Object.keys(state.guides).slice(0, 100);
        const commentIds = Object.keys(state.commentIndex).slice(-300); // newest tail
        if (!guideIds.length) return;
        const key = guideIds.length + ':' + commentIds.length + ':' + (guideIds[guideIds.length - 1] || '');
        if (key === lastSubKey) return;
        lastSubKey = key;
        SkateNostr.sub('skate-guide-io', [
            { kinds: [1111], '#e': guideIds },                       // comments + replies (replies tag the root)
            { kinds: [7], '#e': guideIds.concat(commentIds) }        // votes on guides AND comments
        ], (event) => {
            if (event.kind === 7) handleReaction(event);
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

    /**
     * Toggle a vote on a guide OR a comment. Publishes '+' to vote, '-' to
     * retract; applies optimistically and reverts if no relay accepts it.
     */
    async function toggleReaction(targetId, identity) {
        const guide = state.guides[targetId];
        const comment = !guide && state.commentIndex[targetId]
            ? state.guides[state.commentIndex[targetId]]?.comments.find(c => c.id === targetId) : null;
        const target = guide || comment;
        if (!target) return false;

        const reactions = target.reactions;
        const wasUp = myVote(reactions, identity.pk);
        const content = wasUp ? '-' : '+';
        const prev = reactions[identity.pk];
        // Strictly-increasing ts: a tap + un-tap inside the same second would
        // otherwise emit two reactions with equal created_at, and latest-wins
        // tie-breaking would drop the retraction (here AND on other clients).
        const ts = Math.max(Math.floor(Date.now() / 1000), (prev?.ts || 0) + 1);
        applyReaction(reactions, identity.pk, !wasUp, ts);
        notify();

        const parentGuide = guide || state.guides[state.commentIndex[targetId]];
        const tags = [['e', targetId], ['p', target.author], ['k', guide ? '30023' : '1111']];
        if (parentGuide?.address) tags.splice(1, 0, ['a', parentGuide.address]);

        const template = { kind: 7, content, tags, created_at: ts };
        try {
            const mined = await SkateMod.mine({ ...template, pubkey: identity.pk }, SkateMod.POW.vote);
            const event = NostrTools.finalizeEvent(mined, identity.sk);
            const ok = await SkateNostr.publish(event);
            if (!ok) throw new Error('no relay ack');
            return true;
        } catch {
            // revert the optimistic flip
            if (prev) reactions[identity.pk] = prev; else delete reactions[identity.pk];
            notify();
            return false;
        }
    }

    async function comment(guideId, text, identity, parentCommentId = null) {
        const guide = state.guides[guideId];
        text = (text || '').trim().slice(0, 500);
        if (!guide || !text) return false;
        const verdict = await SkateMod.check(text);
        if (!verdict.ok) throw new Error('That comment won\'t fly here');

        const tags = [['e', guideId], ['a', guide.address], ['p', guide.author], ['k', '30023'], ['client', identity.name || 'Skater']];
        if (parentCommentId && state.commentIndex[parentCommentId] === guideId) {
            const parent = guide.comments.find(c => c.id === parentCommentId);
            tags.splice(1, 0, ['e', parentCommentId]);      // second e-tag = reply parent
            if (parent) tags.push(['p', parent.author]);
        }
        const template = { kind: 1111, content: text, tags, created_at: Math.floor(Date.now() / 1000) };
        const mined = await SkateMod.mine({ ...template, pubkey: identity.pk }, SkateMod.POW.comment);
        const event = NostrTools.finalizeEvent(mined, identity.sk);
        const ok = await SkateNostr.publish(event);
        if (ok) handleComment(event);
        return ok;
    }

    // ---------- Read surface ----------
    function decorate(g) {
        return {
            ...g,
            votes: countUp(g.reactions),
            comments: g.comments.map(c => ({ ...c, votes: countUp(c.reactions) })),
            pinned: state.pins.includes(g.id) || state.pins.includes(g.address)
        };
    }

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
                return (countUp(b.reactions) - countUp(a.reactions)) || (b.ts - a.ts);
            })
            .map(decorate);
    }

    function get(id) {
        const g = state.guides[id];
        return g && visible(g) ? decorate(g) : null;
    }

    function hasVoted(id, pubkey) {
        const g = state.guides[id];
        if (g) return myVote(g.reactions, pubkey);
        const parent = state.commentIndex[id] && state.guides[state.commentIndex[id]];
        const c = parent?.comments.find(c => c.id === id);
        return c ? myVote(c.reactions, pubkey) : false;
    }

    return {
        load, list, get, postGuide, comment, hasVoted, onUpdate, CATEGORIES, OWNER_PUBKEY,
        vote: toggleReaction, voteComment: toggleReaction,
        get loaded() { return state.loaded; }
    };
})();

if (typeof module !== 'undefined') module.exports = SkateGuides;
