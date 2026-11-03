#!/usr/bin/env node
/**
 * check-wheel — the mouse wheel, arriving as arrow keys, scrolls; a real ↑ still walks history.
 * `npm run check:wheel` (needs a build). See `src/ui/keys.ts#wheelBurst`.
 */
if (!process.argv.includes('-p')) process.argv.push('-p'); // never open a TUI from a gate
const { wheelBurst } = await import('../dist/ui/keys.js');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`); if (!c) fails++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ok(same(wheelBurst('\x1b[A\x1b[A\x1b[A'), { dir: 'up', n: 3 }), 'three ↑ in one chunk is a wheel notch up');
ok(same(wheelBurst('\x1bOB\x1bOB\x1bOB'), { dir: 'down', n: 3 }), 'application-cursor ↓ ×3 is a notch down');
ok(wheelBurst('\x1b[A') === null, 'one ↑ in a chunk is a key — prompt history');
ok(wheelBurst('\x1b[A\x1b[B') === null, 'mixed arrows are not a notch');
ok(wheelBurst('\x1b[Aabc') === null, 'an arrow with typing is not a notch');
ok(wheelBurst('hello') === null, 'text is not a notch');
console.log(fails ? `\nwheel check: ${fails} FAILED` : '\nwheel check: ok');
process.exit(fails ? 1 : 0);
