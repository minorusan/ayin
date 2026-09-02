#!/usr/bin/env node
/**
 * Guard: per-tool card glyphs — every tool has one, each is one cell, and a card still reads as a card.
 *
 * Three things can rot here, and none of them throws:
 *
 *   1. A NEW TOOL WITH NO ICON silently falls back to the default triangle. Cosmetic, but the point of
 *      the feature is that a transcript is scannable by its left column, and one anonymous tool in the
 *      set undoes that for the tool you were looking for.
 *
 *   2. A WIDE ICON shifts the transcript. `check-glyphs.mjs` covers the codepoint rule; this re-checks
 *      it through the REAL renderer, so the runtime fallback (`toolGlyph`) is verified too — that is
 *      the path a third-party tool from `AYIN_TOOL_DIRS` takes, which no build gate can reach.
 *
 *   3. THE DETECTOR STOPS SEEING HEADERS. `startsToolCard` used to test `startsWith('▸')`; per-tool
 *      icons made that wrong, and a wrong answer there costs the blank line before every card AND
 *      misplaces the token-cost label onto the header instead of the result. `check-cost.mjs` asserts
 *      the SOURCE contains the call — it cannot tell whether the predicate still returns true.
 */
import { readdirSync, readFileSync } from 'node:fs';

// `-p` so the UI module graph initializes headless and blessed never touches the terminal.
process.argv.push('-p');
// The BARREL first, on purpose: `ui/index.js` constructs a ChatLog at module scope, and reaching
// `widgets/chat.js` directly enters that cycle from the wrong end ("Cannot access 'ChatLog' before
// initialization"). Importing the barrel walks the graph in the order the app walks it.
await import('../dist/ui/index.js');
const { formatToolCallForChat, startsToolCard } = await import('../dist/ui/widgets/chat.js');

let bad = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${msg}`);
  if (!cond) bad++;
};

// ── 1 · every tool declares one ─────────────────────────────────────────────
const ICON = /\bicon\s*(?::|=)\s*(['"`])(.*?)\1/;
const defs = readdirSync('src/tools/defs').filter((f) => f.endsWith('.ts'));
const missing = [];
const icons = new Map();
for (const name of defs) {
  const m = ICON.exec(readFileSync(`src/tools/defs/${name}`, 'utf8'));
  if (!m) missing.push(name);
  else icons.set(name.replace(/\.ts$/, ''), m[2]);
}
ok(missing.length === 0, `all ${defs.length} tool def(s) declare an icon${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);

// ── 2 · each one survives the renderer as exactly one cell ──────────────────
const strip = (s) => s.replace(/\{[^}]*\}/g, '');
let wrongWidth = [];
for (const [tool, icon] of icons) {
  const painted = strip(formatToolCallForChat(tool, 'x', icon));
  // header = glyph + space + name + " · x"
  const expected = [...`${icon} ${tool} · x`].length;
  if ([...painted].length !== expected || !painted.startsWith(icon)) wrongWidth.push(`${tool}:${icon}`);
}
ok(wrongWidth.length === 0, `every icon paints as itself, one cell${wrongWidth.length ? ` — ${wrongWidth.join(' ')}` : ''}`);

// ── 3 · the runtime fallback, for tools no build gate can see ───────────────
// AN EMOJI IS KEPT NOW. It was downgraded because blessed measured it as one cell and the terminal
// painted two; `ui/width.ts` patches that measurement, so a two-cell glyph is simply a two-cell glyph
// and the layout knows it. What still falls back is anything whose width no terminal agrees on.
ok(strip(formatToolCallForChat('t', '', '\u{1F527}')).startsWith('\u{1F527}'),
  'an emoji icon is PAINTED, not downgraded — width.ts taught blessed it is two cells');
ok(strip(formatToolCallForChat('t', '', '⚙️')).startsWith('⚙️'),
  'so is a pictograph carrying a variation selector — one character, two cells');
ok(strip(formatToolCallForChat('t', '', '\u{1F468}‍\u{1F469}‍\u{1F466}')).startsWith('▸'),
  'a ZWJ sequence still falls back — one cluster in one emulator, three glyphs in another');
ok(strip(formatToolCallForChat('t', '', '\u{1F1FA}\u{1F1E6}')).startsWith('▸'),
  'and so does a flag — two regional indicators have no width every terminal agrees on');
ok(strip(formatToolCallForChat('t', '', undefined)).startsWith('▸'),
  'a tool with no icon gets the default glyph');

// ── 4 · a card still reads as a card ────────────────────────────────────────
const undetected = [];
for (const [tool, icon] of icons) {
  if (!startsToolCard(formatToolCallForChat(tool, 'x', icon))) undetected.push(tool);
}
ok(undetected.length === 0,
  `every per-tool header is recognised as a card boundary${undetected.length ? ` — missed: ${undetected.join(', ')}` : ''}`);
ok(startsToolCard(formatToolCallForChat('t', 'x', undefined)), 'so is a default-glyph header');
ok(!startsToolCard('{yellow-fg}│{/} some tool output'), 'a card BODY is not a boundary — it would double the blank lines');
ok(!startsToolCard('plain system notice'), 'and neither is untagged text');

// ── 5 · the OTHER renderer: headless stdout, which a parent agent counts ─────
//
// `subagents.ts` counts tool calls out of a child's headless output, and that count is the number the
// subagent help tells the operator means "the child changed nothing". It was keyed to `▸`, so per-tool
// icons silently zeroed it — children that built whole projects reported 0 tool call(s). Two
// renderers, two matchers; this asserts the plaintext one against every real icon.
const { HEADLESS_TOOL_HEADER } = await import('../dist/subagents.js');
// FLAGS AND ALL. Rebuilding it as `'gm'` dropped the `u`, so the gate tested a DIFFERENT regex from
// the one that ships — and reported the shipped one broken for every emoji icon while it was fine.
const headlessCount = (s) => (s.match(new RegExp(HEADLESS_TOOL_HEADER.source, HEADLESS_TOOL_HEADER.flags)) ?? []).length;
const missedHeadless = [];
for (const [tool, icon] of icons) {
  if (headlessCount(`[tool] ${icon} ${tool} · x=1`) !== 1) missedHeadless.push(`${tool}:${icon}`);
}
ok(missedHeadless.length === 0,
  `every per-tool header is counted in headless stdout${missedHeadless.length ? ` — missed: ${missedHeadless.join(' ')}` : ''}`);
ok(headlessCount('[tool] ▸ t · x=1') === 1, 'so is a default-glyph header');
ok(headlessCount('[tool] │ subagent finished — 0 tool call(s), 61s') === 0,
  'a card BODY is not counted — that line is the result, not a second call');
ok(headlessCount('[tool] ╰ ✓ 1m1s') === 0, 'and neither is the card footer');
ok(headlessCount('[tool] ◍ subagent · task=x\n[tool] │ body\n[tool] ❯ bash · command=ls') === 2,
  'two headers among their bodies count as two');

// ── 6 · the WIDTH PATCH: blessed must agree with the terminal ────────────────
//
// This is what makes an emoji icon safe at all. blessed's double-wide table predates emoji and answers
// 1 for a glyph terminals paint in 2 cells; a row laid out on that answer spills past the right edge,
// the terminal wraps it onto a line blessed does not know exists, and smartCSR redraws everything
// after it one position off. It burned the status bar twice. `ui/width.ts` corrects the measurement —
// asserted here BOTH ways, because a patch that over-corrects (CJK, combining marks, plain ASCII)
// would break far more than it fixed.
const { installWidthPatch, displayWidth } = await import('../dist/ui/width.js');
installWidthPatch();
const blessedLib = (await import('blessed')).default;
const W = (s) => blessedLib.unicode.strWidth(s);
const WIDTHS = [
  ['\u{1F527}', 2, 'an emoji is two cells — the case blessed got wrong'],
  ['\u{1F4E6}', 2, 'and so is another, from a different block'],
  ['⚙️', 2, 'a pictograph plus VS16 is two — the selector promotes it'],
  ['⚙', 1, 'the same pictograph bare is one — the selector is the difference'],
  ['⚙︎', 1, 'VS15 forces text presentation back to one'],
  ['漢', 2, 'CJK is still two — the part blessed already had right'],
  ['Ａ', 2, 'a fullwidth letter is still two'],
  ['ｱ', 1, 'halfwidth kana is still one'],
  ['❯', 1, 'an ordinary BMP symbol is still one'],
  ['abc', 3, 'ASCII is untouched'],
  ['á', 1, 'a combining mark still adds nothing'],
];
const wrong = WIDTHS.filter(([s, want]) => W(s) !== want || displayWidth(s) !== want);
for (const [s, want, why] of WIDTHS) {
  ok(W(s) === want && displayWidth(s) === want, `${why} — blessed ${W(s)}, displayWidth ${displayWidth(s)}, want ${want}`);
}
ok(wrong.length === 0, 'blessed and the terminal agree on every case above');

if (bad) {
  console.error(`\n${bad} tool-icon check(s) failed.`);
  process.exit(1);
}
console.log('tool icon check: ok');
