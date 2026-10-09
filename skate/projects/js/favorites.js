/**
 * SkateFavorites — the ♡ saved sessions (v3.8: split out of chat-v2 so the
 * schedule never needs the community code; ids are unchanged, so existing
 * saves carry over).
 *
 * A saved session is a 16-hex id hashed from activity | location | date |
 * time (FNV-1a with four mixing rounds), kept in localStorage.
 */
window.SkateFavorites = (() => {
    'use strict';

    const KEY = 'skate_favorites_v2';
    let favorites = new Set();

    /** Deterministic 32-hex hash (the chat module shares it for group ids). */
    function hashSync(str) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) { hash ^= str.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
        let result = '';
        for (let round = 0; round < 4; round++) {
            hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
            hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
            hash ^= hash >>> 16;
            result += (hash >>> 0).toString(16).padStart(8, '0');
        }
        return result;
    }

    function load() {
        try {
            const saved = localStorage.getItem(KEY);
            if (saved) favorites = new Set(JSON.parse(saved));
        } catch {}
    }
    function save() {
        try { localStorage.setItem(KEY, JSON.stringify([...favorites])); } catch {}
    }
    function getId(program) {
        const activity = program.Activity || program['Activity Title'] || '';
        const location = program.LocationName || program['Location Name'] || '';
        const date = program['Start Date Time'] || program['Start Date'] || '';
        const time = program['Start Time'] || '';
        return hashSync(`${activity}|${location}|${date}|${time}`).slice(0, 16);
    }
    function toggle(program) {
        const id = getId(program);
        const toast = (m, t) => window.SkateUI && SkateUI.toast(m, t, 2000);
        if (favorites.has(id)) { favorites.delete(id); toast('Removed from saved', 'info'); }
        else { favorites.add(id); toast('Saved ❤️', 'success'); }
        save();
        return favorites.has(id);
    }
    function has(program) { return favorites.has(getId(program)); }
    /** Drop a saved session quietly (the ended-session sweep). */
    function remove(program) { if (favorites.delete(getId(program))) save(); }
    function count() { return favorites.size; }

    return { load, save, getId, toggle, has, remove, count, hashSync };
})();

if (typeof module !== 'undefined') module.exports = window.SkateFavorites;
