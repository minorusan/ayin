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
ok(strip(formatToolCallForChat('t', '', '\u{1F527}')).startsWith('▸'),
  'an emoji from an AYIN_TOOL_DIRS tool falls back to the default glyph, never paints 2 cells');
ok(strip(formatToolCallForChat('t', '', '\u{1F468}‍\u{1F469}‍\u{1F466}')).startsWith('▸'),
  'a ZWJ sequence falls back too — one code point is not the same as one cell');
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

if (bad) {
  console.error(`\n${bad} tool-icon check(s) failed.`);
  process.exit(1);
}
console.log('tool icon check: ok');
