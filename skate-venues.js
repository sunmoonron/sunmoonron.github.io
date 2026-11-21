/**
 * Venue readers: the seasonal skating venues that publish their own page
 * instead of a feed (outdoor rinks that only exist in winter, plus a few
 * arenas with a hand-written schedule).
 *
 * The pipeline fetches; these functions only read. Each reader is
 *     READERS[name](body, { today: 'YYYY-MM-DD', daysAhead: n })  →  Reading
 * and is pure: no network, no files, no clock. Every date is worked out
 * from ctx.today, in UTC on the date parts, so a result never depends on
 * the machine it runs on.
 *
 * Reading = {
 *   state:   'open' | 'pending' | 'closed' | 'unknown',
 *   note:    one plain sentence (at most 200 characters),
 *   quote:   the page's own status sentence, verbatim (optional, at most 160),
 *   season:  { from, to } as far as the page states it (optional),
 *   sessions: [{ date, start, end, activity?, venue?, note? }]   only inside
 *            [today, today + daysAhead], sorted by date then start,
 *   venues:  bramptonOutdoor only: every row of its status table
 * }
 *
 * These rinks appear when winter arrives and are gone afterwards, so every
 * reader is built to refuse rather than to guess:
 *   - a session exists only if the page states it (a date list, a dated
 *     range, or weekly hours next to a positive "open");
 *   - a page that does not look the way its reader expects is 'unknown',
 *     with no sessions, and the pipeline flags it;
 *   - commented-out markup, hidden blocks and scripts are removed before
 *     anything is read: several of these pages keep last season's status
 *     line in an HTML comment or a hidden web part;
 *   - a date written without a year is dated from the page's own season,
 *     and dropped when the weekday printed beside it disagrees.
 * Nothing here throws on bad input.
 */
'use strict';

const NOTE_MAX = 200;
const QUOTE_MAX = 160;
const REMARK_MAX = 120;
const MAX_DAYS_AHEAD = 366;
/* Far above anything these pages hold (the biggest is 200 KB and 4,100 tags; the longest table has 41 rows, the Brampton one 16 rinks): past these a page is not one of them. */
const MAX_PAGE_CHARS = 3000000;
const MAX_TAGS = 60000;
const MAX_ROWS = 400;
const MAX_VENUES = 100;
/* No outdoor rink in the GTA has ice in these months. A status-line page that still reads "open" then is a stale page. */
const NO_OUTDOOR_ICE_MONTHS = [5, 6, 7, 8, 9, 10];

/* ================= text ================= */

const NAMED_ENTITIES = new Map(Object.entries({
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    hellip: '…', bull: '•', middot: '·', deg: '°', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', agrave: 'à', shy: '', zwnj: '', zwj: ''
}));

/** One pass, so "&amp;nbsp;" stays the text "&nbsp;" instead of turning into a space. Unknown names are left as written. */
function decodeEntities(text) {
    return String(text).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,30});/gi, (whole, body) => {
        if (body[0] === '#') {
            const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        const hit = NAMED_ENTITIES.has(body) ? NAMED_ENTITIES.get(body) : /^(?:AMP|LT|GT|QUOT|NBSP)$/.test(body) ? NAMED_ENTITIES.get(body.toLowerCase()) : undefined;
        return hit === undefined ? whole : hit;
    });
}

/**
 * The page as a visitor's browser shows it: HTML comments, scripts and styles removed.
 * Walked in document order, so a comment inside a script, or a script tag inside a
 * comment, cannot swallow the real markup that follows it.
 */
function visibleHtml(html) {
    const src = typeof html === 'string' ? html : '';
    const open = /<!--|<(script|style)\b/gi;
    let out = '', at = 0, m;
    while ((m = open.exec(src))) {
        let end;
        if (m[1]) {
            const close = new RegExp(`</${m[1]}\\s*>`, 'gi');
            close.lastIndex = open.lastIndex;
            const hit = close.exec(src);
            end = hit ? hit.index + hit[0].length : src.length;
        } else {
            const hit = src.indexOf('-->', m.index + 2);          // "<!-->" is a whole comment
            end = hit < 0 ? src.length : hit + 3;
        }
        out += src.slice(at, m.index) + ' ';
        at = end;
        open.lastIndex = end;
    }
    return out + src.slice(at);
}

const sentences = (text) => String(text || '').split(/(?<=[.!?])\s+(?=[A-Z0-9"'“‘(])/).map((s) => s.trim()).filter(Boolean);

function clip(text, max) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/* ================= markup =================
 * No DOM, and nothing that can run away on a broken page. Every helper walks the tags once, in order, and a tag never
 * reaches past the next "<": patterns such as "<tr>…</tr>" or "<div[^>]*>" re-read the rest of the page for every
 * tag that is never closed, which on a page of unclosed tags is minutes of work. Where a reader then works through the
 * content of each element it finds, it asks for a few elements and reads a bounded piece of each.
 */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'em', 'font', 'i', 'kbd', 'mark', 'nobr', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr']);
const LINE_TAGS = new Set(['br', 'p', 'div', 'li', 'ul', 'ol', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'aside', 'blockquote', 'figure']);
/* Zero-width space, non-joiner and joiner, word joiner, soft hyphen: on these pages by the dozen, and never visible. */
const INVISIBLE = new RegExp(`[${[0x200b, 0x200c, 0x200d, 0x2060, 0xad].map((code) => String.fromCharCode(code)).join('')}]`, 'g');
/* How much of one element a reader looks at: a heading or label, and a whole block (a schedule group, an hours box). */
const LABEL_CHARS = 1000;
const BLOCK_CHARS = 60000;

/**
 * The tags of the markup, in order: { name, close, attrs, start, end }; the name is lower case, and '' for <!…> and <?…>.
 * A tag is "<", a name, then anything but "<" and ">" up to a ">": a "<" that meets another "<" first is text (so is
 * an attribute with a raw "<" in it, which these pages do not have). One pass, linear in the length of the page
 * whatever it holds, and lazy: a caller that has what it came for stops reading.
 */
function* tagsOf(html) {
    const opening = /<(\/?)([a-z][a-z0-9:-]*)|<[!?]/iy;             // sticky: tried at one position, never scanned ahead
    let at = html.indexOf('<');
    while (at >= 0) {
        const next = html.indexOf('<', at + 1);
        opening.lastIndex = at;
        const m = opening.exec(html);
        if (m) {
            const from = opening.lastIndex;
            const close = html.slice(from, next < 0 ? html.length : next).indexOf('>');
            if (close >= 0) yield { name: (m[2] || '').toLowerCase(), close: m[1] === '/', attrs: m[2] ? html.slice(from, from + close) : '', start: at, end: from + close + 1 };
        }
        at = next;
    }
}
const selfClosed = (tag) => VOID_TAGS.has(tag.name) || tag.attrs.trimEnd().endsWith('/');

/** The markup with its tags taken out: nothing where an inline tag was, a space where any other was (a line break, if `byLine`, for the ones that start a new line). */
function untag(html, byLine) {
    const s = String(html == null ? '' : html);
    let out = '', at = 0;
    for (const tag of tagsOf(s)) {
        out += s.slice(at, tag.start) + (INLINE_TAGS.has(tag.name) ? '' : byLine && LINE_TAGS.has(tag.name) ? '\n' : ' ');
        at = tag.end;
    }
    return out + s.slice(at);
}
const tidy = (text) => decodeEntities(text).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();

/** Markup → what a visitor reads, on one line: tags gone, entities decoded, invisible characters dropped, whitespace collapsed. */
const plain = (html) => tidy(untag(html, false));

/** Markup → its visual lines (a <br>, a block boundary or a line break in the source starts a new one), empty lines dropped. */
const lines = (html) => untag(html, true).split('\n').map(tidy).filter(Boolean);

const ATTR = new Map();
function attr(attrs, name) {
    if (!ATTR.has(name)) ATTR.set(name, new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
    const m = ATTR.get(name).exec(attrs || '');
    return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : null;
}
const hasClass = (attrs, name) => attrs.includes(name) && (attr(attrs, 'class') || '').split(/\s+/).includes(name);

/**
 * The first `limit` <name> elements whose attributes pass `test`, in document order: { tag, attrs, inner, start, end }.
 * `name` is a tag name or a pattern for one. Same-name elements nest by depth; one that is never closed runs to the
 * end, as in a browser; a <p> ends where the next <p> starts. Reading stops as soon as the last element asked for is closed.
 */
function elements(html, name, test, limit = 50) {
    const wanted = typeof name === 'string' ? (n) => n === name : (n) => name.test(n);
    const open = new Map();                                          // tag name → the elements of that name still open
    const found = [];
    let unfinished = 0;                                              // found, and still waiting for an end tag
    for (const tag of tagsOf(html)) {
        if (!tag.name || !wanted(tag.name)) continue;
        if (!open.has(tag.name)) open.set(tag.name, []);
        const stack = open.get(tag.name);
        if (tag.close || tag.name === 'p') {
            const ended = stack.pop();
            if (ended) {
                ended.innerEnd = tag.start;
                ended.end = tag.close ? tag.end : tag.start;
                if (ended.kept) unfinished--;
            }
        }
        if (!tag.close) {
            const el = { tag: tag.name, attrs: tag.attrs, start: tag.start, innerStart: tag.end, innerEnd: html.length, end: html.length, kept: found.length < limit && (!test || test(tag.attrs)) };
            if (selfClosed(tag)) { el.innerEnd = tag.end; el.end = tag.end; } else { stack.push(el); if (el.kept) unfinished++; }
            if (el.kept) found.push(el);
        }
        if (found.length >= limit && !unfinished) break;
    }
    return found.map((el) => ({ tag: el.tag, attrs: el.attrs, inner: html.slice(el.innerStart, el.innerEnd), start: el.start, end: el.end }));
}

/** The markup without every element (start tag through its end tag) that `drop(tagName, attributes)` picks. */
function strip(html, drop) {
    let out = '', at = 0, inside = null;                             // inside: the dropped element still open, { name, depth }
    for (const tag of tagsOf(html)) {
        if (inside) {
            if (tag.name !== inside.name) continue;
            if (!tag.close) { if (!selfClosed(tag)) inside.depth++; continue; }
            if (--inside.depth > 0) continue;
            at = tag.end;
            inside = null;
        } else if (tag.name && !tag.close && drop(tag.name, tag.attrs)) {
            out += html.slice(at, tag.start) + ' ';
            at = tag.end;
            if (!selfClosed(tag)) { inside = { name: tag.name, depth: 1 }; at = html.length; }      // until its end tag turns up, the rest goes with it
        }
    }
    return out + html.slice(at);
}

/**
 * The first `limit` table rows as lists of cells: { head: is a <th>, attrs, html }. A cell ends at its end tag, at the
 * next cell or at the end of its row, whichever comes first, so the pages' odd nesting (a <div> between <tr> and
 * <td>) and missing end tags read the same way.
 */
function tableRows(html, limit = MAX_ROWS) {
    const s = String(html || '');
    const rows = [];
    let row = null, cell = null, stopped = -1;
    const endCell = (at) => { if (cell) { row.push({ head: cell.head, attrs: cell.attrs, html: s.slice(cell.from, at) }); cell = null; } };
    for (const tag of tagsOf(s)) {
        const starts = !tag.close && (tag.name === 'tr' || ((tag.name === 'td' || tag.name === 'th') && !row));
        if (starts && rows.length >= limit) { stopped = tag.start; break; }
        if (tag.name === 'tr') {
            endCell(tag.start);
            row = null;
            if (!tag.close) { row = []; rows.push(row); }
        } else if (tag.name === 'td' || tag.name === 'th') {
            endCell(tag.start);
            if (tag.close) continue;
            if (!row) { row = []; rows.push(row); }
            cell = { head: tag.name === 'th', attrs: tag.attrs, from: tag.end };
        }
    }
    endCell(stopped < 0 ? s.length : stopped);
    return rows;
}

/* ================= dates (UTC on the date parts) ================= */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SRC = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY_SRC = '(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
const monthNum = (name) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(String(name).slice(0, 3).toLowerCase()) + 1;
const dayNum = (name) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(String(name).slice(0, 3).toLowerCase());

const pad = (n) => String(n).padStart(2, '0');
/** A real calendar date as 'YYYY-MM-DD', or null (February 30, month 13, a year outside 2000 to 2100). */
function ymd(y, m, d) {
    if (![y, m, d].every(Number.isInteger) || y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}
const dateParts = (date) => [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(...dateParts(s)) === s;
function addDays(date, n) {
    const [y, m, d] = dateParts(date);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
/** 0 = Sunday … 6 = Saturday. */
function weekdayOf(date) {
    const [y, m, d] = dateParts(date);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
const nice = (date) => `${MONTH_NAMES[dateParts(date)[1] - 1]} ${dateParts(date)[2]}, ${dateParts(date)[0]}`;

/** Every "Month D, YYYY" in the text (ordinals, missing commas and abbreviated months included), in order. */
function fullDates(text) {
    const re = new RegExp(`\\b(${MONTH_SRC})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)\\b`, 'gi');
    return [...String(text || '').matchAll(re)].map((m) => ymd(Number(m[3]), monthNum(m[1]), Number(m[2]))).filter(Boolean);
}

/** A skating season runs July to June. The first year of the one that contains `date`. */
const seasonYear = (date) => (dateParts(date)[1] >= 7 ? dateParts(date)[0] : dateParts(date)[0] - 1);
/** A month and day with no year, dated inside the season that contains `today` (November 2026 … April 2027). */
const inSeason = (month, day, today) => ymd(month >= 7 ? seasonYear(today) : seasonYear(today) + 1, month, day);
/** A month and day with no year, dated inside a stated span: December belongs to its first year, January to its last. */
function inSpan(month, day, span) {
    const [fromYear, fromMonth] = dateParts(span.from);
    const toYear = dateParts(span.to)[0];
    return ymd(fromYear === toYear || month >= fromMonth ? fromYear : toYear, month, day);
}

/** { today, last, days[] } for a valid ctx, else null. */
function windowOf(ctx) {
    if (!ctx || !isDate(ctx.today)) return null;
    const n = Number(ctx.daysAhead);
    const ahead = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_DAYS_AHEAD) : 0;
    const days = [];
    for (let i = 0; i <= ahead; i++) days.push(addDays(ctx.today, i));
    return { today: ctx.today, last: days[days.length - 1], days };
}

/**
 * Which weekdays a label names: "Daily", "Monday to Friday", "Saturday, Sunday, Holidays", "Weekend", "Mondays".
 * "Holidays" names no weekday: a holiday counts only where the page gives it a dated row of its own.
 */
function daySet(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(?:daily|every\s?day|all\s+week|7\s+days)\b/.test(t)) return new Set([0, 1, 2, 3, 4, 5, 6]);
    const out = new Set();
    if (/\bweekdays\b/.test(t)) [1, 2, 3, 4, 5].forEach((d) => out.add(d));
    if (/\bweekends?\b/.test(t)) [6, 0].forEach((d) => out.add(d));
    const span = new RegExp(`\\b(${DAY_SRC})s?\\b\\.?\\s*(?:to|through|thru|-|–|—)\\s*(${DAY_SRC})s?\\b`, 'g');
    const rest = t.replace(span, (whole, a, b) => {
        for (let d = dayNum(a), i = 0; i < 7; d = (d + 1) % 7, i++) { out.add(d); if (d === dayNum(b)) break; }
        return ' ';
    });
    for (const m of rest.matchAll(new RegExp(`\\b(${DAY_SRC})s?\\b`, 'g'))) out.add(dayNum(m[1]));
    return out;
}

/* ================= times ================= */

const HALF_SRC = '(a\\.?m\\.?|p\\.?m\\.?|noon)(?![a-z])';
const CLOCK_SRC = `(\\bnoon\\b|\\bmidnight\\b|\\d{1,2}(?::\\d{2})?)(?![\\d:])(?:\\s*${HALF_SRC})?`;
const RANGE_SRC = `(?<![\\d:$])${CLOCK_SRC}\\s*(?:-|–|—|\\bto\\b|\\buntil\\b|\\bthrough\\b)\\s*${CLOCK_SRC}`;
const hhmm = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const halfOf = (s) => String(s || '').toLowerCase().replace(/[.\s]/g, '');

/** Minutes after midnight for a 12-hour clock reading, or null. 24-hour clocks are refused: none of these pages uses them. */
function clockMinutes(clock, half) {
    const c = String(clock).toLowerCase();
    if (c === 'noon') return 720;
    if (c === 'midnight') return 1440;
    const [h, mm = '0'] = c.split(':');
    const hour = Number(h), minute = Number(mm);
    if (!(hour >= 1 && hour <= 12) || !(minute >= 0 && minute <= 59)) return null;
    if (half === 'noon') return hour === 12 && minute === 0 ? 720 : null;
    return ((hour % 12) + (half === 'pm' ? 12 : 0)) * 60 + minute;
}

/**
 * One range → { start, end } as 'HH:MM', or null. The end must carry a.m./p.m. (or be noon or midnight): an end
 * without one would be a guess. A start without one takes the end's half of the day ("12 to 3 p.m.", "3 to 7 p.m."),
 * unless that would put it at or after the end ("10 - 2 PM", "9 to 12 p.m." start in the morning).
 */
function toRange(clock1, half1, clock2, half2) {
    const h1 = halfOf(half1), h2 = halfOf(half2);
    const endIsWord = /^(?:noon|midnight)$/i.test(clock2);
    if (!endIsWord && !h2) return null;
    let end = clockMinutes(clock2, h2);
    if (end === null) return null;
    if (end === 0) end = 1440;                                  // "to 12 a.m." closes the day
    let start;
    if (/^noon$/i.test(clock1)) start = 720;
    else if (/^midnight$/i.test(clock1)) start = 0;
    else if (h1) start = clockMinutes(clock1, h1);
    else {
        const same = end <= 720 ? 'am' : 'pm';
        start = [clockMinutes(clock1, same), clockMinutes(clock1, same === 'pm' ? 'am' : 'pm')].find((v) => v !== null && v < end);
        if (start === undefined) return null;
    }
    if (start === null || start >= end) return null;
    return { start: hhmm(start), end: hhmm(Math.min(end, 1439)) };
}

/** Every time range in the text, in order: { start, end, index, length }. */
function timeRanges(text) {
    const s = String(text || '');
    const re = new RegExp(RANGE_SRC, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(s))) {
        const r = toRange(m[1], m[2], m[3], m[4]);
        if (r) out.push({ start: r.start, end: r.end, index: m.index, length: m[0].length });
        else re.lastIndex = m.index + 1;                        // "Feb 15 – 10 – 5 PM": the range starts one number later
    }
    return out;
}
const timeRange = (text) => { const r = timeRanges(text)[0]; return r ? { start: r.start, end: r.end } : null; };

/** A single clock time that says a.m. or p.m. ("9:00pm", "6pm") → 'HH:MM', or null. */
function clockTime(text) {
    const m = new RegExp(`(?<![\\d:$])${CLOCK_SRC}`, 'i').exec(String(text || ''));
    if (!m) return null;
    if (!m[2] && !/^(?:noon|midnight)$/i.test(m[1])) return null;
    const v = clockMinutes(m[1], halfOf(m[2]));
    return v === null ? null : hhmm(Math.min(v, 1439));
}

/* ================= the words pages use about being open ================= */

const SEASON_OVER = /\bclosed\s+for\s+(?:the|this)\s+(?:\w+\s+)?season\b|\bseason\s+(?:has\s+|is\s+)?(?:now\s+)?(?:ended|over|finished|concluded|closed)\b|\b(?:until|see\s+you)\s+next\s+(?:winter|season|year)\b/i;
const NOT_YET = new RegExp(
    '\\bwill\\s+(?:re-?)?open\\b|\\bto\\s+re-?open\\b|\\bre-?open(?:s|ing)?\\b|\\bnot\\s+(?:yet\\s+)?open\\b|\\bopening\\s+(?:soon|day|date)\\b|\\bcoming\\s+soon\\b|\\bstay\\s+tuned\\b'
    + `|\\bopen(?:s|ing)?\\s+(?:on\\s+|in\\s+|this\\s+|next\\s+|early\\s+|late\\s+|mid-?\\s*)*(?:${MONTH_SRC}|${DAY_SRC}|soon|tomorrow|winter|fall|autumn|spring|week|month|year)\\b`
    + '|\\bopen(?:s|ing)?\\s+for\\s+the\\s+season\\s+(?:soon|on|in|this|next|when|once|later)\\b', 'i');
const SHUT = /\bclosed\b|\bclosures?\b|\bcancel(?:l?ed|lation)?\b|\bshut\b|\bunavailable\b/i;
/* Beside one date or one line of a schedule: that entry is off. */
const CALLED_OFF = /\bcancel(?:l?ed|lation)?\b|\bclosed\b|\bpostponed\b|\brescheduled\b|\bno\s+(?:public\s+)?(?:skat\w+|programs?|drop-?ins?)\b/i;
const SAYS_OPEN = /\bfree\s+admission\b|\badmission\s+is\s+(?:always\s+)?free\b|\b(?:is|are)\s+(?:now\s+)?open\b|\bnow\s+open\b|\b(?:rink|trail|ice)\s+open\b|\bopen\s+(?:daily|every\s?day|today|now|all\s+week|7\s+days|for\s+the\s+season)\b|\bwe(?:'|’)?re\s+open\b/i;

/**
 * What a status line says: 'closed' (for the season), 'later' (will open, reopens, opening soon), 'shut' (closed, with no
 * word about the season), 'open' (only a positive statement), or null. Anything negative wins over anything positive.
 */
function rinkWording(text) {
    const t = String(text || '');
    if (SEASON_OVER.test(t)) return 'closed';
    if (NOT_YET.test(t)) return 'later';
    if (SHUT.test(t)) return 'shut';
    return SAYS_OPEN.test(t) ? 'open' : null;
}

/* ================= readings ================= */

function tidySessions(list, win) {
    const seen = new Set();
    const out = [];
    for (const s of Array.isArray(list) ? list : []) {
        if (!s || !isDate(s.date) || s.date < win.today || s.date > win.last) continue;
        if (!/^\d{2}:\d{2}$/.test(s.start || '') || !/^\d{2}:\d{2}$/.test(s.end || '') || s.start >= s.end) continue;
        const key = [s.date, s.start, s.end, s.activity || '', s.venue || ''].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const session = { date: s.date, start: s.start, end: s.end };
        if (s.activity) session.activity = clip(s.activity, REMARK_MAX);
        if (s.venue) session.venue = s.venue;
        if (s.note) session.note = clip(s.note, REMARK_MAX);
        out.push(session);
    }
    const rank = (s) => [s.date, s.start, s.end, s.venue || '', s.activity || ''].join('|');
    return out.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
}

/** The Reading, in its contract shape. 'unknown' never carries sessions. */
function reading(win, state, note, more = {}) {
    const out = { state, note: clip(note, NOTE_MAX) };
    if (more.quote) out.quote = clip(more.quote, QUOTE_MAX);
    if (more.season && (more.season.from || more.season.to)) {
        out.season = {};
        if (more.season.from) out.season.from = more.season.from;
        if (more.season.to) out.season.to = more.season.to;
    }
    out.sessions = state === 'unknown' ? [] : tidySessions(more.sessions, win);
    if (more.venues) out.venues = more.venues;
    return out;
}
const unknown = (win, note, more = {}) => reading(win, 'unknown', note, { ...more, sessions: [] });

/**
 * Rules over the window, between optional bounds, minus `skip` dates. A rule is weekly ({ day, start, end }) or for one
 * date ({ date, start, end }), and may carry activity, note, venue and bounds of its own (from, to).
 */
function weekly(win, rules, { from, to, skip } = {}) {
    const sessions = [];
    const seen = new Set();
    const distinct = rules.filter((r) => { const key = JSON.stringify(r); return !seen.has(key) && Boolean(seen.add(key)); }).slice(0, MAX_ROWS);
    for (const date of win.days) {
        if ((from && date < from) || (to && date > to) || (skip && skip.has(date))) continue;
        const day = weekdayOf(date);
        for (const r of distinct) {
            if (r.date ? r.date !== date : r.day !== day) continue;
            if ((r.from && date < r.from) || (r.to && date > r.to)) continue;
            sessions.push({ date, start: r.start, end: r.end, activity: r.activity, venue: r.venue, note: r.note });
        }
    }
    return sessions;
}

/** "OCT 11-12-13, DEC 24-25-26-31, JAN 1" → dates, each dated by `resolve(month, day)`. Two numbers far apart ("DEC 24-31") are read as a span: the cautious reading. */
function closedDates(text, resolve) {
    const out = new Set();
    const re = new RegExp(`\\b(${MONTH_SRC})\\b\\.?\\s+(\\d{1,2}(?![\\d:])(?:st|nd|rd|th)?(?:\\s*(?:-|–|—|,|&|and)\\s*\\d{1,2}(?![\\d:])(?:st|nd|rd|th)?)*)`, 'gi');
    for (const m of String(text || '').matchAll(re)) {
        let days = m[2].split(/\s*(?:-|–|—|,|&|and)\s*/).map((d) => parseInt(d, 10));
        if (days.length === 2 && /-|–|—/.test(m[2]) && days[1] > days[0] + 1) days = Array.from({ length: days[1] - days[0] + 1 }, (x, i) => days[0] + i);
        for (const d of days) { const date = resolve(monthNum(m[1]), d); if (date) out.add(date); }
    }
    return out;
}

/** The dates a closure line names: spans ("December 24 to January 1", "Dec 24 – Jan 1") filled in, then single days and lists. */
function closureDates(text, resolve) {
    const out = new Set();
    const span = new RegExp(`\\b(${MONTH_SRC})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:(?:to|through|until)\\s+(?:(${MONTH_SRC})\\b\\.?\\s+)?|(?:-|–|—)\\s*(${MONTH_SRC})\\b\\.?\\s+)(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
    const rest = String(text || '').replace(span, (whole, m1, d1, m2a, m2b, d2) => {
        const from = resolve(monthNum(m1), Number(d1)), to = resolve(monthNum(m2a || m2b || m1), Number(d2));
        if (!from || !to || from > to || addDays(from, 62) < to) return whole;
        for (let d = from; d <= to; d = addDays(d, 1)) out.add(d);
        return ' ';
    });
    closedDates(rest, resolve).forEach((d) => out.add(d));
    return out;
}

const staleOutdoors = (win) => NO_OUTDOOR_ICE_MONTHS.includes(dateParts(win.today)[1]);
const staleNote = (win) => `The page reads as open in ${MONTH_NAMES[dateParts(win.today)[1] - 1]}, when no outdoor rink has ice, so it is probably out of date.`;

/* ================= 1. Harbourfront Centre: Skate by the Lake ================= */

/**
 * The status is the visible div#header-tix (older lines sit beside it in HTML comments, among them a superseded
 * opening date). The hours table stays on the page while the rink is shut, so it proves nothing by itself:
 * sessions need the status line to say open in so many words.
 */
function harbourfront(body, win) {
    const html = visibleHtml(body);
    const status = elements(html, 'div', (a) => attr(a, 'id') === 'header-tix', 5).map((e) => plain(e.inner.slice(0, LABEL_CHARS))).filter(Boolean);
    if (!status.length) return unknown(win, 'The status line at the top of the page was not found.');
    const hoursBox = elements(html, 'div', (a) => attr(a, 'id') === 'hours', 1).map((e) => e.inner.slice(0, BLOCK_CHARS))[0];
    const beside = hoursBox ? plain(strip(hoursBox, (tag) => tag === 'table' || /^h[1-6]$/.test(tag))) : '';
    const head = elements(html, 'div', (a) => attr(a, 'id') === 'dev-header-copy', 1)[0];
    const span = head ? fullDates(lines(head.inner.slice(0, LABEL_CHARS))[0]) : [];          // "Fri, Nov 28, 2025 ↑ Sun, Mar 1, 2026", or just "Winter 2026/27"
    const season = span.length === 2 && span[0] <= span[1] ? { from: span[0], to: span[1] } : null;

    const said = [...status, beside].filter(Boolean).map((text) => ({ text, means: rinkWording(text) }));
    const first = (means) => said.find((s) => s.means === means);
    if (first('closed')) return reading(win, 'closed', 'The page says the rink is closed for the season.', { quote: first('closed').text, season });
    if (first('later')) return reading(win, 'pending', 'The rink is not open yet: the page says it will open later.', { quote: first('later').text, season });
    if (first('shut')) return reading(win, 'pending', 'The page says the rink is closed at the moment.', { quote: first('shut').text, season });
    const quote = status.find((text) => rinkWording(text) === 'open');
    if (!quote) return unknown(win, 'The status line does not say whether the rink is open.', { quote: status[0], season });

    if (season && win.today > season.to) return reading(win, 'closed', `The season on the page ended on ${nice(season.to)}.`, { quote, season });
    if (season && win.today < season.from) return reading(win, 'pending', `The season on the page starts on ${nice(season.from)}.`, { quote, season });
    if (staleOutdoors(win)) return unknown(win, staleNote(win), { quote, season });

    const table = hoursBox ? elements(hoursBox, 'table', (a) => hasClass(a, 'rink-hours-table'), 1)[0] : null;
    if (!table) return unknown(win, 'The page says the rink is open, but its hours table is missing.', { quote, season });
    const rules = [];
    let unreadable = 0;
    for (const cells of tableRows(table.inner)) {
        if (cells.length < 2 || cells.every((c) => c.head)) continue;
        const days = daySet(plain(cells[0].html));
        const hours = plain(cells[1].html);
        const range = timeRange(hours);
        if (!days.size || (!range && !/^closed\b/i.test(hours))) { unreadable++; continue; }
        if (range) days.forEach((day) => rules.push({ day, start: range.start, end: range.end }));
    }
    if (unreadable || !rules.length) return unknown(win, 'The page says the rink is open, but its hours table could not be read.', { quote, season });
    return reading(win, 'open', `The page says the rink is open${season ? ` until ${nice(season.to)}` : ''}; the hours are its weekly Rink Hours.`,
        { quote, season, sessions: weekly(win, rules, season || {}) });
}

/* ================= 2. The Bentway skate trail ================= */

const SERVICE_ROW = /\b(?:rentals?|concessions?|sharpening|lessons?)\b/i;

/** "Friday, January 15, TDSB PA Day" → { weekday, month, day, year, rest } (weekday and year may be null), or null. */
function monthDay(text) {
    const m = new RegExp(`^(?:(${DAY_SRC})\\b\\.?,?\\s+)?(${MONTH_SRC})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(20\\d\\d)\\b)?[\\s,:;–—-]*(.*)$`, 'i').exec(String(text || '').trim());
    return m ? { weekday: m[1] ? dayNum(m[1]) : null, month: monthNum(m[2]), day: Number(m[3]), year: m[4] ? Number(m[4]) : null, rest: m[5].trim() } : null;
}

/** "Over the holidays: December 12 to January 3" → { from, to } inside the season, or null. The whole paragraph must be the label. */
function labelledSpan(text, season) {
    const m = new RegExp(`^(?:[^:]{1,60}:\\s*)?(${MONTH_SRC})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:to|until|through|-|–|—)\\s*(?:(${MONTH_SRC})\\b\\.?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\.?$`, 'i').exec(String(text || '').trim());
    if (!m) return null;
    const from = inSpan(monthNum(m[1]), Number(m[2]), season);
    const to = inSpan(monthNum(m[3] || m[1]), Number(m[4]), season);
    return from && to && from <= to ? { from, to } : null;
}

/**
 * The hours in the event's text: a paragraph that is a date range, directly followed by a table of weekday rows
 * ("Daily", "Monday to Friday", "Saturday, Sunday, Holidays"), plus rows that carry a date of their own
 * ("Friday, January 15, TDSB PA Day"), which replace the weekday rule on that date. Rows about rentals or
 * concessions are not hours. Nobody guesses which days are "holidays".
 */
function bentwayHours(html, season) {
    const periods = [];
    const dated = new Map();
    let label = null, labelEnd = -1, tableEnd = -1, tables = 0;
    for (const part of elements(html, /^(?:p|table)$/, null, 1000)) {
        if (part.start < tableEnd) continue;                         // a paragraph inside the table just read
        if (part.tag === 'p') { label = plain(part.inner); labelEnd = part.end; continue; }
        if (++tables > 40) break;
        tableEnd = part.end;
        const direct = label !== null && !plain(html.slice(labelEnd, part.start));
        const span = direct ? labelledSpan(label, season) : null;
        const period = span ? { from: span.from, to: span.to, byDay: new Map() } : null;
        label = null;
        for (const cells of tableRows(part.inner.slice(0, BLOCK_CHARS))) {
            if (cells.length < 2) continue;
            const what = plain(cells[0].html), when = plain(cells[1].html);
            if (SERVICE_ROW.test(`${what} ${when}`)) continue;
            const day = monthDay(what);
            if (day) {
                const date = day.year ? ymd(day.year, day.month, day.day) : inSpan(day.month, day.day, season);
                if (!date || date < season.from || date > season.to) continue;
                const range = timeRange(when);
                if (day.weekday !== null && weekdayOf(date) !== day.weekday) dated.set(date, { drop: true });     // "Friday, January 15" in a year where it is not a Friday: a stale row
                else if (CALLED_OFF.test(`${what} ${when}`)) dated.set(date, { drop: true });
                else if (range) dated.set(date, { start: range.start, end: range.end, note: day.rest });
                else dated.set(date, { remark: [day.rest, when].filter(Boolean).join(': '), until: clockTime((/\bopen\s+until\s+(.*)$/i.exec(when) || [])[1]) });
                continue;
            }
            if (!period) continue;
            const days = daySet(what), range = timeRange(when);
            if (days.size && range) days.forEach((d) => period.byDay.set(d, { start: range.start, end: range.end }));
        }
        if (period && period.byDay.size) periods.push(period);
    }
    return { periods, dated };
}

function acfDate(value) {
    const s = String(value == null ? '' : value).trim();
    const iso = /^(\d{4})-?(\d{2})-?(\d{2})\b/.exec(s);
    return iso ? ymd(Number(iso[1]), Number(iso[2]), Number(iso[3])) : (fullDates(s)[0] || null);
}

/** body = the JSON of /wp-json/wp/v2/event?slug=winter-skating (an array with one event, or the event itself). */
function bentway(body, win) {
    let data;
    try { data = JSON.parse(body); } catch { return unknown(win, 'The response was not the event data this reader expects.'); }
    const list = (Array.isArray(data) ? data : [data]).filter((e) => e && typeof e === 'object' && !Array.isArray(e));
    const text = (v) => (v && typeof v === 'object' ? v.rendered : v);
    const event = list.find((e) => e.acf && typeof e.acf === 'object' && /skat/i.test(`${e.slug || ''} ${text(e.title) || ''} ${e.link || ''}`));
    if (!event) return unknown(win, 'The response holds no skating event.');
    const from = acfDate(event.acf.start_date), to = acfDate(event.acf.end_date);
    if (!from || !to || from > to) return unknown(win, 'The skating event has no readable start and end dates.');
    const season = { from, to };
    const html = visibleHtml(typeof text(event.content) === 'string' ? text(event.content) : '');

    // the sentence that states the season, for the status page
    const said = lines(html).flatMap(sentences);
    const names = (date) => new RegExp(`\\b${MONTH_NAMES[dateParts(date)[1] - 1].slice(0, 3)}[a-z]*\\.?\\s+${dateParts(date)[2]}\\b`, 'i');
    const quote = said.find((s) => names(from).test(s) && names(to).test(s)) || said.find((s) => /\bfinal\s+day\b/i.test(s) && names(to).test(s));

    if (win.today > to) return reading(win, 'closed', `The skating season on the page ended on ${nice(to)}.`, { quote, season });
    const { periods, dated } = bentwayHours(html, season);
    // a sentence that calls the trail off on dates of its own ("closed December 25") removes them; rentals and concessions are not the trail
    const off = new Set();
    for (const s of said) {
        if (CALLED_OFF.test(s) && !SERVICE_ROW.test(s)) closureDates(s, (month, day) => inSpan(month, day, season)).forEach((d) => off.add(d));
    }
    const sessions = [];
    for (const date of win.days) {
        if (date < from || date > to || off.has(date)) continue;
        const special = dated.get(date);
        if (special && special.drop) continue;
        if (special && special.start) { sessions.push({ date, start: special.start, end: special.end, note: special.note }); continue; }
        const period = periods.find((p) => date >= p.from && date <= p.to);
        const hours = period && period.byDay.get(weekdayOf(date));
        if (!hours) continue;
        const end = special && special.until && special.until > hours.start ? special.until : hours.end;
        sessions.push({ date, start: hours.start, end, note: special ? special.remark : undefined });
    }
    const readable = periods.length > 0;
    if (win.today < from) {
        return reading(win, 'pending', `The skate trail opens on ${nice(from)} and runs to ${nice(to)}${readable ? '' : '; its hours are not posted yet'}.`, { quote, season, sessions });
    }
    if (!readable) return unknown(win, 'The season is on by its dates, but no hours table could be read from the page.', { quote, season });
    return reading(win, 'open', `The skate trail is in season until ${nice(to)}; hours are from the page's own tables.`, { quote, season, sessions });
}

/* ================= 3. Evergreen Brick Works ================= */

/**
 * Dated lists with no years, which stay on the page all summer. Three guards: the banner and intro ("closed for this
 * season", "last season's") shut everything; a date whose weekday (printed beside it, or implied by a group called
 * "Weekend" or "Friday") is wrong for this season is dropped, and when a third or more of the checkable dates are
 * wrong the whole page is last season's; nothing is read before a reopening date the page gives.
 */
function evergreen(body, win) {
    const html = visibleHtml(body);
    const groups = elements(html, 'div', (a) => hasClass(a, 'collapse_wrap'), 24)
        .map((box) => box.inner.slice(0, BLOCK_CHARS))
        .map((inner) => ({ inner, title: elements(inner, 'h4', (a) => hasClass(a, 'title-h4'), 1)[0] }))
        .map((g) => ({ inner: g.inner, name: g.title ? plain(g.title.inner.slice(0, LABEL_CHARS)) : '' }))
        .filter((g) => /skat/i.test(g.name));
    const banner = elements(html, 'div', (a) => hasClass(a, 'info_banner'), 3).map((e) => plain(e.inner.slice(0, BLOCK_CHARS))).filter(Boolean).join(' ');
    const intro = elements(html, 'div', (a) => hasClass(a, 'top_container'), 6)
        .flatMap((top) => elements(top.inner.slice(0, BLOCK_CHARS), 'div', (a) => hasClass(a, 'txt'), 3).map((e) => lines(e.inner).join(' '))).filter(Boolean).join(' ');
    const about = [...sentences(banner), ...sentences(intro)];
    if (!groups.length && !about.some((s) => /skat/i.test(s))) return unknown(win, 'The public skating dates were not found on the page.');

    const gone = about.find((s) => SEASON_OVER.test(s) || /\blast\s+season\b/i.test(s));
    if (gone) return reading(win, 'closed', 'The page says public skating has closed for the season; any dates it still lists are last season\'s.', { quote: gone });
    // any other closure notice either names its dates ("cancelled today, December 28") or stops the reader
    const off = new Set();
    for (const notice of about.filter((s) => SHUT.test(s))) {
        const dates = closureDates(notice, (month, day) => inSeason(month, day, win.today));
        if (!dates.size) return unknown(win, 'The page carries a closure notice this reader cannot place on the calendar.', { quote: notice });
        dates.forEach((d) => off.add(d));
    }

    const DATE = new RegExp(`^(?:(${DAY_SRC})\\.?,?\\s*)?(${MONTH_SRC})\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:\\((.*)\\))?$`, 'i');
    let entries = [];
    let checkable = 0, wrongDay = 0, unread = 0;
    for (const g of groups) {
        const implied = daySet(g.name);                              // "Weekend Public Skate" → Saturday, Sunday; "Friday Public Skate" → Friday
        const box = elements(g.inner, 'div', (a) => hasClass(a, 'txt'), 1)[0];
        let everyDay = null;
        const byDay = new Map();
        for (const line of box ? lines(box.inner) : []) {           // "From 10:00 am – 5:00 pm", or "Saturdays 1:00 pm – 6:00 pm" and "Sundays …"
            const range = timeRanges(line)[0];
            if (!range) continue;
            const days = daySet(line.slice(0, range.index));
            if (days.size) days.forEach((d) => byDay.set(d, range));
            else if (!everyDay) everyDay = range;
        }
        for (const cell of tableRows(g.inner).flat().slice(0, MAX_ROWS)) {
            const text = plain(cell.html);
            if (!text) continue;
            const m = DATE.exec(text);
            const date = m ? inSeason(monthNum(m[2]), Number(m[3]), win.today) : null;
            if (!date || CALLED_OFF.test(text) || off.has(date)) { unread++; continue; }     // "Dec 24 (Cancelled)" is not a session with a remark
            const expected = m[1] ? [dayNum(m[1])] : implied.size ? [...implied] : null;
            if (expected) {
                checkable++;
                if (!expected.includes(weekdayOf(date))) { wrongDay++; continue; }
            }
            const inside = m[4] || '';
            const own = timeRanges(inside)[0];                       // "(11am – 5pm)", "(10am – 8pm - Free rentals available!)", "(Free rentals available!)"
            const remark = (own ? `${inside.slice(0, own.index)} ${inside.slice(own.index + own.length)}` : inside).replace(/\s+/g, ' ').replace(/^[\s:;,–—-]+|[\s:;,–—-]+$/g, '');
            const hours = own || byDay.get(weekdayOf(date)) || everyDay;
            if (!hours) { unread++; continue; }
            entries.push({ date, start: hours.start, end: hours.end, note: remark || undefined });
        }
    }
    const stale = wrongDay > 0 && wrongDay * 3 >= checkable;
    if (stale) entries = [];
    const later = about.find((s) => NOT_YET.test(s) && new RegExp(`\\b${MONTH_SRC}\\b\\.?\\s+\\d{1,2}\\b`, 'i').test(s)) || about.find((s) => NOT_YET.test(s));
    const opens = new RegExp(`\\b(?:re-?)?open(?:s|ing)?\\s+(?:on\\s+)?(?:${DAY_SRC}\\b\\.?,?\\s+)?(${MONTH_SRC})\\b\\.?\\s+(\\d{1,2})\\b`, 'i').exec(about.join(' '));
    const notBefore = opens ? inSeason(monthNum(opens[1]), Number(opens[2]), win.today) : null;
    if (notBefore) entries = entries.filter((e) => e.date >= notBefore);

    if (!entries.length) {
        if (stale) return reading(win, 'pending', 'The dates on the page do not fit this season\'s calendar, so they are last season\'s; this season\'s dates are not posted yet.', { quote: later });
        if (later) return reading(win, 'pending', 'The page announces public skating but lists no dates yet.', { quote: later });
        return unknown(win, 'No public skating dates could be read from the page.');
    }
    const dates = entries.map((e) => e.date).sort();
    const season = { from: dates[0], to: dates[dates.length - 1] };
    const listed = `${entries.length} skating ${entries.length === 1 ? 'date is' : 'dates are'} listed, from ${nice(season.from)} to ${nice(season.to)}`
        + (wrongDay + unread ? ` (${wrongDay + unread} more could not be used)` : '');
    if (win.today > season.to) return reading(win, 'closed', `The last skating date on the page was ${nice(season.to)}.`, { season });
    if (win.today < season.from) return reading(win, 'pending', `Public skating has not started: ${listed}.`, { quote: later, season, sessions: entries });
    return reading(win, 'open', `Public skating is on: ${listed}.`, { season, sessions: entries });
}

/* ================= 4. Mattamy Athletic Centre: community skates ================= */

/**
 * Dated lines under the community-skates heading, each with its own year. The list that follows the rule (<hr>) is
 * for the university's students, faculty and staff and is never read. A line whose weekday does not match its date is dropped.
 */
function mattamy(body, win) {
    const html = visibleHtml(body);
    const heads = elements(html, 'h3', null, 60).map((h) => ({ text: plain(h.inner.slice(0, LABEL_CHARS)), end: h.end }));
    const head = heads.find((h) => /\bcommunity\b/i.test(h.text) && !/\b(?:students?|faculty|staff|alumni)\b/i.test(h.text));
    if (!head) return unknown(win, 'The community skates heading was not found on the page.');
    const rest = html.slice(head.end);
    const stop = rest.search(/<hr\b|<h3\b/i);
    const LINE = new RegExp(`^[\\s•*–—-]*(?:(${DAY_SRC})\\b\\.?,?\\s+)?(${MONTH_SRC})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)\\b(.*)$`, 'i');
    const skates = [];
    for (const line of lines(stop < 0 ? rest : rest.slice(0, stop)).slice(0, MAX_ROWS)) {
        const m = LINE.exec(line);
        if (!m || CALLED_OFF.test(line)) continue;                    // a dated line marked cancelled or postponed is not a skate
        const date = ymd(Number(m[4]), monthNum(m[2]), Number(m[3]));
        const range = timeRange(m[5]);
        if (!date || !range || (m[1] && weekdayOf(date) !== dayNum(m[1]))) continue;
        skates.push({ date, start: range.start, end: range.end, line });
    }
    if (!skates.length) return unknown(win, 'No dated community skate was found under the heading.');
    skates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const next = skates.find((s) => s.date >= win.today);
    const last = skates[skates.length - 1];
    if (!next) return reading(win, 'closed', `Every community skate on the page is past; the last one was on ${nice(last.date)}.`, { quote: last.line });
    const ahead = skates.filter((s) => s.date >= win.today).length;
    return reading(win, 'open', `${ahead} community ${ahead === 1 ? 'skate is' : 'skates are'} listed; the next is on ${nice(next.date)}.`,
        { quote: next.line, sessions: skates.map(({ date, start, end }) => ({ date, start, end })) });
}

/* ================= 5. Mississauga Celebration Square ================= */

/**
 * Only the "Ice rink" row of the hours block and the "Ice rink" accordion are read: the page also describes a
 * fountain, which is closed for the season exactly when the rink is open. Hours with nothing negative beside them
 * mean open; the accordion's dated holiday lines replace the weekly hours on those dates.
 */
function mississaugaSquare(body, win) {
    const html = visibleHtml(body);
    const isRink = (text) => /^(?:ice|skating)\s+rink\b/i.test(text);
    const names = elements(html, 'div', (a) => hasClass(a, 'space-name'), 60);
    const at = names.findIndex((e) => isRink(plain(e.inner.slice(0, LABEL_CHARS))));
    if (at < 0) return unknown(win, 'The "Ice rink" row of the hours block was not found.');
    // the rink's own row: the innermost div.row around its name (failing that, the markup up to the next space or section)
    const around = elements(html, 'div', (a) => hasClass(a, 'row'), 5000).filter((r) => r.start < names[at].start && r.end >= names[at].end);
    const tail = html.slice(names[at].end);
    const next = at + 1 < names.length ? names[at + 1].start - names[at].end : tail.search(/<(?:section|aside|button|h[1-6])\b/i);
    const row = (around.length ? around[around.length - 1].inner : tail.slice(0, next < 0 ? 4000 : next)).slice(0, BLOCK_CHARS);
    const small = elements(row, 'div', (a) => hasClass(a, 'small') && !hasClass(a, 'accordion-content'), 5).map((e) => plain(e.inner)).filter(Boolean).join(' ');

    // the accordion about the rink: its title ("Ice rink (closed for the season)") and the prose before its gallery
    const titles = elements(html, 'button', (a) => hasClass(a, 'accordion-title'), 100);
    const button = titles.find((b) => isRink(plain(b.inner.slice(0, LABEL_CHARS))));
    const panel = button ? elements(html.slice(button.end, button.end + 20000), 'div', (a) => hasClass(a, 'accordion-content'), 1)[0] : null;
    const title = button ? plain(button.inner.slice(0, LABEL_CHARS)) : '';
    const prose = panel ? lines(panel.inner.split(/<h[1-6]\b|<div\b/i)[0]) : [];
    const said = [...prose.flatMap(sentences), title, small].filter(Boolean);

    const over = said.find((s) => SEASON_OVER.test(s));
    if (over) {
        const back = said.find((s) => /\bre-?open/i.test(s) || /\bwill\s+open\b/i.test(s));
        return back
            ? reading(win, 'pending', 'The rink is closed for the season and the page says it will reopen.', { quote: back })
            : reading(win, 'closed', 'The page says the rink is closed for the season.', { quote: over });
    }

    const table = elements(row, 'table', (a) => hasClass(a, 'hours-table-extended'), 1)[0];
    if (!table) return unknown(win, 'The hours table for the ice rink was not found.');
    const byDay = new Map();
    let unreadable = 0;
    for (const cells of tableRows(table.inner)) {
        if (cells.length < 2) continue;
        const days = daySet(plain(cells[0].html));
        const hours = plain(strip(cells[1].html, (tag) => tag === 'div'));
        const remark = elements(cells[1].html, 'div', null, 5).map((e) => plain(e.inner)).filter(Boolean).join(' ');
        const range = timeRange(hours);
        if (days.size !== 1 || (!range && !/^closed\b/i.test(hours))) { unreadable++; continue; }
        byDay.set([...days][0], range ? { start: range.start, end: range.end, once: Boolean(remark) } : null);
    }
    if (unreadable || !byDay.size) return unknown(win, 'The hours table for the ice rink could not be read.');
    // "temporarily closed", with no date of its own, is about now (the standing "may need to close temporarily" is not such a line)
    const shutNow = said.find((s) => SHUT.test(s) && !closureDates(s, (month, day) => inSeason(month, day, win.today)).size);
    if (shutNow) return reading(win, 'pending', 'The page says the rink is closed at the moment.', { quote: shutNow });
    if (![...byDay.values()].some(Boolean)) return reading(win, 'closed', 'The page lists the ice rink as closed on every day, without saying why.');
    const later = said.find((s) => NOT_YET.test(s));
    if (later) return reading(win, 'pending', 'The rink is not open yet: the page says it will open later.', { quote: later });
    if (staleOutdoors(win)) return unknown(win, staleNote(win));

    // "Christmas Eve (December 24): 10 a.m.-6 p.m." replaces the weekly hours on that date; a line that cannot be read removes the date
    const special = new Map();
    for (const line of prose) {
        const m = new RegExp(`^(.*?)\\(\\s*(${MONTH_SRC})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*\\)\\s*:?\\s*(.*)$`, 'i').exec(line);
        const date = m ? inSeason(monthNum(m[2]), Number(m[3]), win.today) : null;
        if (!date) continue;
        const range = CALLED_OFF.test(m[4]) ? null : timeRange(m[4]);
        special.set(date, range ? { start: range.start, end: range.end, note: m[1].replace(/[\s:–—-]+$/, '').trim() } : null);
    }
    for (const s of prose.flatMap(sentences)) {                         // "The rink will be closed on February 3 for maintenance."
        if (CALLED_OFF.test(s)) closureDates(s, (month, day) => inSeason(month, day, win.today)).forEach((d) => special.set(d, null));
    }
    const firstWeek = addDays(win.today, 6);
    const sessions = [];
    for (const date of win.days) {
        if (special.has(date)) { if (special.get(date)) sessions.push({ date, ...special.get(date) }); continue; }
        const hours = byDay.get(weekdayOf(date));
        if (!hours || (hours.once && date > firstWeek)) continue;       // a row with a remark of its own speaks for this week's date only
        sessions.push({ date, start: hours.start, end: hours.end });
    }
    return reading(win, 'open', 'The page lists hours for the ice rink and nothing says it is closed.', { quote: prose.find((s) => /^open\b/i.test(s)), sessions });
}

/* ================= 6. Brampton: outdoor rinks status table ================= */

/**
 * One table, a row per rink: name and address, hours, status, reason. Everything inside an element with the class
 * ms-hide is thrown away first (a hidden web part keeps an old weather advisory). Sessions come only from rows whose
 * status is plainly "Open", and never from a row that points to a schedule of its own (Gore Meadows has its own reader).
 */
function bramptonOutdoor(body, win) {
    const html = strip(visibleHtml(body), (tag, a) => hasClass(a, 'ms-hide'));
    const table = elements(html, 'table', null, 20).find((t) => {
        const top = (tableRows(t.inner.slice(0, LABEL_CHARS), 1)[0] || []).map((c) => plain(c.html)).join(' ');
        return /\brink\b/i.test(top) && /\bstatus\b/i.test(top);
    });
    if (!table) return unknown(win, 'The rink status table was not found.');
    const linkTexts = (cell) => elements(cell, 'a', null, 12).map((a) => plain(a.inner.slice(0, LABEL_CHARS))).filter(Boolean);
    const venues = [];
    const sessions = [];
    for (const cells of tableRows(table.inner, MAX_VENUES)) {
        if (cells.length < 3 || cells.every((c) => c.head)) continue;
        const [who, when, how, why = ''] = cells.map((c) => c.html);
        const link = who.search(/<a\b/i);
        const name = plain(link < 0 ? who : who.slice(0, link));
        if (!name) continue;
        const address = linkTexts(who).find((t) => !/\bschedule\b/i.test(t)) || '';
        const hourLines = lines(strip(when, (tag) => tag === 'a'));
        const status = lines(how).join('; ');
        const reason = plain(why).replace(/^[\s–—-]+$/, '');
        const parts = lines(how).map((s) => s.replace(/^rinks?\s*#?\d+(?:\s*(?:,|&|and)\s*#?\d+)*\s*[:–—-]?\s*/i, '').trim()).filter(Boolean);
        const open = parts.length > 0 && parts.every((p) => /^open$/i.test(p));
        venues.push({ name, address, hours: hourLines.join('; '), status, reason, open });
        const ownSchedule = [...linkTexts(who), ...linkTexts(when)].some((t) => /\bschedule\b/i.test(t)) || /\b(?:see|view)\s+(?:the\s+)?schedule\b/i.test(plain(when));
        if (!open || ownSchedule) continue;

        const named = [], bare = [];
        for (const line of hourLines) {
            const m = /^([A-Za-z][A-Za-z &/'-]{1,40}?)\s*:\s*(.+)$/.exec(line);
            const found = timeRanges(m ? m[2] : line);
            if (!found.length) continue;                              // "Hours and schedule TBD"
            if (!m) { bare.push(...found.map((r) => ({ start: r.start, end: r.end, activity: 'Public Skating' }))); continue; }
            if (!/shinny|hockey|skat|stick|puck/i.test(m[1])) continue;   // a label this reader does not know: leave the line alone
            named.push(...found.map((r) => ({ start: r.start, end: r.end, activity: m[1].trim() })));
        }
        // "10 a.m. to 10 p.m." above "Shinny Hockey: … / Public Skating: …" is the rink's day; the labelled lines are the sessions
        for (const slot of (named.length ? named : bare).slice(0, 12)) {
            for (const date of win.days) sessions.push({ date, start: slot.start, end: slot.end, activity: slot.activity, venue: name, note: reason || undefined });
        }
    }
    if (!venues.length) return unknown(win, 'The rink status table has no rows.');

    // "SEASON UPDATE: …" up to its first line break, and the page's own "Last Updated" stamp
    const update = plain((/SEASON\s+UPDATE\s*:?([\s\S]*?)(?=<br\b|<\/?(?:p|div|aside|ul|li|h[1-6])\b|$)/i.exec(html) || [])[1] || '');
    const updated = plain((/Last\s+Updated\s*:([^<]*)/i.exec(html) || [])[1] || '');
    const stamp = updated ? ` (page last updated ${updated})` : '';
    const openNow = venues.filter((v) => v.open);
    const more = { quote: update || undefined, venues };
    if (openNow.length) {
        if (staleOutdoors(win)) return unknown(win, staleNote(win), more);
        const which = openNow.length === 1 ? `: ${openNow[0].name}` : '';
        return reading(win, 'open', clip(`${openNow.length} of ${venues.length} outdoor rinks ${openNow.length === 1 ? 'is' : 'are'} listed as open${which}${stamp}.`, NOTE_MAX), { ...more, sessions });
    }
    if (SEASON_OVER.test(update)) return reading(win, 'closed', `The page says the outdoor rinks are closed for the season${stamp}.`, more);
    if (NOT_YET.test(update)) return reading(win, 'pending', `No outdoor rink is open yet; the page says they open soon${stamp}.`, more);
    if (venues.every((v) => SEASON_OVER.test(v.reason))) return reading(win, 'closed', `Every outdoor rink is listed as closed for the season${stamp}.`, more);
    if (venues.some((v) => v.reason)) return reading(win, 'pending', `Every outdoor rink is listed as closed at the moment${stamp}.`, more);
    return unknown(win, 'No rink is listed as open and the page does not say why.', more);
}

/* ================= 7. Brampton: Gore Meadows covered rink schedule ================= */

const DROP_IN = (program) => (/\bskat(?:e|ing)\b/i.test(program) && !/learn|lesson|figure|power|develop|program|class|club|camp|private/i.test(program))
    || (/\bshinny\b/i.test(program) && !/develop|lesson|league|program|class|camp/i.test(program));

/**
 * "Schedule for November 16 to December 20, 2026" (the year is written once, at the end), then a table of weekday,
 * program and time. The page may carry more than one such block (this schedule and the next). Public skates and
 * shinny drop-ins are read; lessons, development programs and shoot-arounds are not. Nothing is read outside a
 * block's own range: after the last one ends the page is waiting for its next schedule.
 */
function bramptonGoreMeadows(body, win) {
    const html = strip(visibleHtml(body), (tag, a) => hasClass(a, 'ms-hide'));
    const HEAD = new RegExp(`\\bschedule\\s+for\\s+(${MONTH_SRC})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?\\s*(?:to|until|through|-|–|—)\\s*(?:(${MONTH_SRC})\\b\\.?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)\\b`, 'i');
    const rangeOf = (text) => {
        const m = HEAD.exec(text);
        const toYear = Number(m[6]), toMonth = monthNum(m[4] || m[1]);
        const to = ymd(toYear, toMonth, Number(m[5]));
        const from = ymd(m[3] ? Number(m[3]) : monthNum(m[1]) > toMonth ? toYear - 1 : toYear, monthNum(m[1]), Number(m[2]));     // "December 21 to January 3, 2027" starts the year before
        return from && to && from <= to && addDays(from, 200) >= to ? { from, to } : null;
    };
    // each "Schedule for …" heading opens a block that runs to the next one
    let heads = elements(html, /^h[1-6]$/, null, 300)
        .map((h) => ({ quote: plain(h.inner.slice(0, LABEL_CHARS)), at: h.start, after: h.end })).filter((h) => HEAD.test(h.quote)).slice(0, 12);
    if (!heads.length) {
        const line = lines(html).find((l) => HEAD.test(l));            // the same words outside a heading: one block, the whole page
        if (line) heads = [{ quote: line, at: 0, after: 0 }];
    }
    if (!heads.length) return unknown(win, 'The "Schedule for … to …" heading was not found.');
    const blocks = heads.map((h, i) => ({ ...h, range: rangeOf(h.quote), end: i + 1 < heads.length ? heads[i + 1].at : html.length }));
    const bad = blocks.find((b) => !b.range);
    if (bad) return unknown(win, 'The dates in the schedule heading could not be read.', { quote: bad.quote });

    const byStart = [...blocks].sort((a, b) => (a.range.from < b.range.from ? -1 : 1));
    const final = [...blocks].sort((a, b) => (a.range.to < b.range.to ? -1 : 1))[blocks.length - 1];
    const current = byStart.find((b) => win.today >= b.range.from && win.today <= b.range.to);
    const main = current || byStart.find((b) => b.range.from > win.today);
    if (!main) return reading(win, 'pending', `The schedule on the page ended on ${nice(final.range.to)}; the next one is not posted yet.`, { quote: final.quote, season: final.range });

    for (const b of blocks) {
        const table = elements(html.slice(b.after, b.end), 'table', null, 10).find((t) => {
            const top = (tableRows(t.inner.slice(0, LABEL_CHARS), 1)[0] || []).map((c) => plain(c.html)).join(' ');
            return /\bprogram\b/i.test(top) && /\btime\b/i.test(top);
        });
        b.tableEnd = b.after + (table ? table.end : 0);
        b.rules = [];
        let when = [];
        for (const cells of table ? tableRows(table.inner) : []) {
            if (!cells.length || cells.every((c) => c.head)) continue;
            let data = cells;
            if (cells[0].head || cells.length >= 3) {                 // the day cell spans the rows that follow it
                const label = plain(cells[0].html);
                const days = daySet(label);
                const dated = new RegExp(`\\b(${MONTH_SRC})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i').exec(label);
                if (dated) {                                          // "Thursday, December 24": that date only, and only if its weekday agrees
                    const date = inSpan(monthNum(dated[1]), Number(dated[2]), b.range);
                    when = date && (!days.size || days.has(weekdayOf(date))) ? [{ date }] : [];
                } else when = [...days].map((day) => ({ day }));
                data = cells.slice(1);
            }
            if (!when.length || data.length < 2) continue;
            const program = plain(data[0].html), times = lines(data[1].html).join(' | ');
            if (!DROP_IN(program) || CALLED_OFF.test(`${program} ${times}`)) continue;
            for (const r of timeRanges(times)) for (const w of when) b.rules.push({ ...w, start: r.start, end: r.end, activity: program });
        }
    }
    if (!main.rules.length) return unknown(win, 'The schedule table could not be read.', { quote: main.quote, season: main.range });
    // a line beside the schedules that calls dates off ("closed December 25 and January 1") removes those dates
    const whole = { from: byStart[0].range.from, to: final.range.to };
    const skip = new Set();
    const near = html.slice(Math.max(0, blocks[0].at - 4000), Math.max(...blocks.map((b) => b.tableEnd)) + 3000);
    for (const line of lines(near)) if (CALLED_OFF.test(line)) closureDates(line, (month, day) => inSpan(month, day, whole)).forEach((d) => skip.add(d));
    const sessions = blocks.flatMap((b) => weekly(win, b.rules, { from: b.range.from, to: b.range.to, skip }));
    const { from, to } = main.range;
    if (!current) return reading(win, 'pending', `The schedule on the page starts on ${nice(from)} and runs to ${nice(to)}.`, { quote: main.quote, season: main.range, sessions });
    return reading(win, 'open', `The page gives a weekly schedule from ${nice(from)} to ${nice(to)}, weather and ice permitting.`, { quote: main.quote, season: main.range, sessions });
}

/* ================= 8. George Bell Arena ================= */

/**
 * Lines such as "- Thursdays: 3pm-4pm (Adult), 4pm-5pm (All Ages)" and "- Saturdays: 7pm-8pm* (All Ages)", with a
 * footnote for the star. An older layout wrote "Tuesdays - 3-4PM" under a line with the season's two dates.
 */
function georgeBell(body, win) {
    const html = visibleHtml(body);
    const boxes = elements(html, 'div', (a) => attr(a, 'data-aid') === 'FAQ_SECTION_DESCRIPTION_RENDERED', 12);
    if (!boxes.length) return unknown(win, 'The public skating hours block was not found.');
    const all = boxes.flatMap((b) => lines(b.inner.slice(0, BLOCK_CHARS))).slice(0, MAX_ROWS);
    const DAY_LINE = new RegExp(`^[\\s•*–—-]*(${DAY_SRC})s?\\b\\s*[:–—-]?\\s*(.*)$`, 'i');
    const footnote = (all.find((l) => /^\*/.test(l)) || '').replace(/^\*+\s*/, '');
    const hour = /\b(?:begins?|starts?)\s+at\s+(\d{1,2}(?::\d{2})?)\s*([ap])\.?m\b/i.exec(footnote);
    const starNote = !footnote ? 'Times vary on some weeks.'
        : hour ? `Some weeks this starts at ${hour[1]} ${hour[2].toLowerCase()}m.${/instagram/i.test(footnote) ? ' Check the arena\'s Instagram.' : ''}`
            : clip(footnote, REMARK_MAX);
    const rules = [];
    for (const line of all) {
        const m = DAY_LINE.exec(line);
        if (!m) continue;
        const found = timeRanges(m[2]);
        found.forEach((r, i) => {
            const tail = m[2].slice(r.index + r.length, i + 1 < found.length ? found[i + 1].index : undefined);
            const label = ((/\(([^)]*)\)/.exec(tail) || [])[1] || '').trim();
            const activity = !label ? 'Public Skating' : /\badults?\b/i.test(label) ? 'Public Skating: Adults' : /\ball\s*ages\b/i.test(label) ? 'Public Skating: All Ages' : `Public Skating: ${label}`;
            rules.push({ day: dayNum(m[1]), start: r.start, end: r.end, activity, note: /^\s*\*/.test(tail) ? starNote : undefined });
        });
    }
    const spanLine = all.find((l) => fullDates(l).length === 2 && fullDates(l)[0] <= fullDates(l)[1]);
    const season = spanLine ? { from: fullDates(spanLine)[0], to: fullDates(spanLine)[1] } : null;
    const quote = spanLine || all.find((l) => /skat/i.test(l) && !DAY_LINE.test(l));
    if (season && win.today > season.to) return reading(win, 'closed', `The public skating dates on the page ended on ${nice(season.to)}.`, { quote, season });
    const over = all.find((l) => SEASON_OVER.test(l));
    if (over) return reading(win, 'closed', 'The page says public skating is over for the season.', { quote: over, season });
    if (!rules.length) return unknown(win, 'No weekly public skating time could be read from the page.', { quote, season });
    // the block is short and all of it is about public skating: a line that calls skating off either names its dates or stops the reader
    const skip = new Set();
    for (const line of all) {
        if (!CALLED_OFF.test(line)) continue;
        const dates = closureDates(line, (month, day) => (season ? inSpan(month, day, season) : inSeason(month, day, win.today)));
        if (!dates.size) return unknown(win, 'The page carries a closure notice this reader cannot place on the calendar.', { quote: line, season });
        dates.forEach((d) => skip.add(d));
    }
    const sessions = weekly(win, rules, { ...(season || {}), skip });
    if (season && win.today < season.from) return reading(win, 'pending', `Public skating on the page starts on ${nice(season.from)}.`, { quote, season, sessions });
    const days = [...new Set(rules.map((r) => r.day))].sort().map((d) => ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][d]);
    return reading(win, 'open', `Weekly public skating is listed on ${days.join(', ')}${season ? ` until ${nice(season.to)}` : ''}.`, { quote, season, sessions });
}

/* ================= 9. McCormick Arena ================= */

/**
 * A header with the season ("This schedule STARTS on SEPTEMBER 8th, 2025. (ends on April 30th, 2026)") and the days
 * the arena is closed ("CLOSED ON OCT 11-12-13, DEC 24-25-26-31, JAN 1"), then one card per program: name, price and
 * rules in the title, a start date and weekday lines below. Only the public drop-in skating cards are read. Without
 * both ends of the season there are no sessions.
 */
function mccormick(body, win) {
    const html = visibleHtml(body);
    const header = elements(html, 'div', (a) => hasClass(a, 'section-text'), 12).map((e) => lines(e.inner.slice(0, BLOCK_CHARS)).slice(0, 60)).find((l) => l.some((s) => /\bschedule\b/i.test(s)));
    const titles = elements(html, 'h4', (a) => hasClass(a, 'card-title'), 60);
    if (!header || !titles.length) return unknown(win, 'The schedule header and its program cards were not found.');

    const cards = titles.map((title, i) => {
        const below = html.slice(title.end, i + 1 < titles.length ? titles[i + 1].start : title.end + 4000);
        const text = elements(below, 'p', (a) => hasClass(a, 'mbr-text'), 1)[0];
        const head = lines(title.inner.slice(0, LABEL_CHARS));
        const all = [...head, ...(text ? lines(text.inner) : [])];
        const starts = all.find((l) => /^starts?\b/i.test(l));
        const ends = all.find((l) => /^end(?:s|ed)\b/i.test(l));
        const times = [];
        for (const l of all) {
            const m = new RegExp(`^(${DAY_SRC})s?\\b\\s*:\\s*(.*)$`, 'i').exec(l);
            if (!m || CALLED_OFF.test(m[2])) continue;                // "Tuesday: 4pm to 5:30pm (cancelled …)": not a line to build on
            for (const r of timeRanges(m[2])) times.push({ day: dayNum(m[1]), start: r.start, end: r.end });
        }
        return {
            name: (head[0] || '').replace(/\s*\([^)]*\)/g, '').trim(),
            about: head.join(' '),
            from: starts ? fullDates(starts)[0] : undefined,
            to: ends ? fullDates(ends)[0] : undefined,
            ended: Boolean(ends) && /^ended\b/i.test(ends),
            times
        };
    }).filter((c) => c.name && /skat/i.test(c.name) && !/shinny|hockey|figure|ticket|stick|puck|lesson|learn|regist|permit|rental|league/i.test(c.about));

    const endedLine = header.find((s) => /\bschedule\b.*\bended\b/i.test(s) && fullDates(s).length);
    if (endedLine) {
        return reading(win, 'closed', `The page says its schedule ended on ${nice(fullDates(endedLine)[0])}; no new schedule is posted.`, { quote: endedLine, season: { to: fullDates(endedLine)[0] } });
    }
    const startLine = header.find((s) => /\bstart(?:s|ed|ing)?\b/i.test(s) && fullDates(s).length);
    const endLine = header.find((s) => /\bends?\b/i.test(s) && fullDates(s).length);
    const from = startLine ? fullDates(startLine)[0] : null;
    const to = endLine ? fullDates(endLine)[fullDates(endLine).length - 1] : null;
    if (!from || !to || from > to) {
        if (cards.length && cards.every((c) => c.ended && !c.times.length)) return reading(win, 'closed', 'Every public skating program on the page is marked as ended.', { quote: header.find((s) => /\bschedule\b/i.test(s)) });
        return unknown(win, 'The page does not say when its schedule starts and ends.');
    }
    const season = { from, to };
    const quote = startLine === endLine ? startLine : `${startLine} ${endLine}`;
    if (win.today > to) return reading(win, 'closed', `The schedule on the page ended on ${nice(to)}.`, { quote, season });
    const rules = cards.filter((c) => !c.ended).flatMap((c) => c.times.map((t) => ({ ...t, activity: c.name, from: c.from, to: c.to })));
    if (!rules.length) return unknown(win, 'No public skating times could be read from the program cards.', { quote, season });
    // "CLOSED ON OCT 11-12-13, DEC 24-25-26-31, …" removes those dates; a closure with no dates in it stops the reader
    const skip = new Set();
    for (const line of header) {
        if (!SHUT.test(line)) continue;
        const dates = closureDates(line, (month, day) => inSpan(month, day, season));
        if (!dates.size) return unknown(win, 'The schedule header carries a closure notice this reader cannot place on the calendar.', { quote: line, season });
        dates.forEach((d) => skip.add(d));
    }
    const sessions = weekly(win, rules, { from, to, skip });
    if (win.today < from) return reading(win, 'pending', `The schedule on the page starts on ${nice(from)} and ends on ${nice(to)}.`, { quote, season, sessions });
    return reading(win, 'open', `The schedule on the page runs from ${nice(from)} to ${nice(to)}${skip.size ? `, with ${skip.size} closed days` : ''}.`, { quote, season, sessions });
}

/* ================= the registry ================= */

/** Wraps a reader so it never throws: an empty body, a bad ctx or a crash inside is an 'unknown' reading. */
function guarded(read) {
    return (body, ctx) => {
        const fail = (note) => ({ state: 'unknown', note: clip(note, NOTE_MAX), sessions: [] });
        const win = windowOf(ctx);
        if (!win) return fail('The reader was called without a valid date.');
        const text = typeof body === 'string' ? body : (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) ? body.toString('utf8') : '';
        if (!text.trim()) return fail('The page came back empty.');
        if (text.length > MAX_PAGE_CHARS) return fail('The page is far larger than any page this reader knows.');
        let tags = 0;
        for (const tag of tagsOf(text)) if (tag && ++tags > MAX_TAGS) return fail('The page holds far more markup than any page this reader knows.');
        try { return read(text, win); } catch (e) { return fail(`The page could not be read (${String((e && e.message) || e)}).`); }
    };
}

const READERS = {
    harbourfront: guarded(harbourfront),
    bentway: guarded(bentway),
    evergreen: guarded(evergreen),
    mattamy: guarded(mattamy),
    mississaugaSquare: guarded(mississaugaSquare),
    bramptonOutdoor: guarded(bramptonOutdoor),
    bramptonGoreMeadows: guarded(bramptonGoreMeadows),
    georgeBell: guarded(georgeBell),
    mccormick: guarded(mccormick)
};

module.exports = {
    READERS,
    // helpers, exported for the unit spec
    visibleHtml, plain, lines, elements, strip, tableRows, decodeEntities, timeRange, timeRanges, clockTime, daySet, fullDates, closureDates,
    ymd, addDays, weekdayOf, seasonYear, inSeason, inSpan, rinkWording, NO_OUTDOOR_ICE_MONTHS
};
