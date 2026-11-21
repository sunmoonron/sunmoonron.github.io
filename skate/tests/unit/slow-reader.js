// A stand-in for skate-venues.js in unit/sources.spec.js: one reader that answers, one that never returns, one that throws.
module.exports = { READERS: {
    fine: (body, ctx) => ({ state: 'open', note: `read ${body.length} characters for ${ctx.today}`, sessions: [{ date: ctx.today, start: '10:00', end: '11:00' }] }),
    spin: () => { for (;;) { /* a pattern that never finishes */ } },
    crawl: (body) => /^(a+)+$/.test(body),          // catastrophic backtracking on 'aaaa…!'
    broken: () => { throw new Error('boom'); }
} };
