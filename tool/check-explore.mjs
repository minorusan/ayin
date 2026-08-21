#!/usr/bin/env node
/**
 * check-explore — proves the three properties explore is built on, against the real built code.
 *
 * `npm run check:explore` (needs a build first).
 *
 * The suite this replaced tested an LLM loop: it stood up a fake backend, scripted a model that
 * re-suggested the same command, and asserted the loop noticed. All of that is gone, because the
 * loop is gone — measured at 1 useful answer in 6 real invocations while 27 of its 28 shell commands
 * returned real data. The searching was never the problem; the judging was.
 *
 * So this asserts what the new design actually claims:
 *
 *   DETERMINISTIC — same question, same repository, byte-identical answer. No model, so no sampling.
 *   CANNOT LIE    — every quoted line is re-read from disk and compared to the file. If explore
 *                   prints `foo.ts:42 │ bar`, then line 42 of foo.ts says `bar`, or this fails.
 *   READ-ONLY     — the probe runner refuses any binary or flag that can write, and takes argv
 *                   ARRAYS rather than strings, so there is no shell to inject into.
 *
 * Fixtures are built on disk in a temp directory, so the assertions are about behaviour rather than
 * about the shape of the source.
 */

import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.argv.push('-p'); // headless: never take the terminal

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DIST = join(REPO, 'dist');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const { ensureToolRuntime } = await import(`file://${join(DIST, 'tool-wiring.js')}`);
ensureToolRuntime();
const { exploreExecute, pickExplorer } = await import(`file://${join(DIST, 'tools/explore/index.js')}`);
const { extractTerms } = await import(`file://${join(DIST, 'tools/explore/terms.js')}`);
const { runProbe } = await import(`file://${join(DIST, 'tools/explore/search.js')}`);
const { guidOf, asmdefOf } = await import(`file://${join(DIST, 'tools/explore/projects/unity.js')}`);

// ── fixtures ─────────────────────────────────────────────────────────
const TMP = mkdtempSync(join(tmpdir(), 'ayin-explore-'));

/** A Unity project: script + .meta guid + a prefab and an .anim that reference it by guid. */
const U = join(TMP, 'unity');
const GUID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
mkdirSync(join(U, 'Assets/Scripts'), { recursive: true });
mkdirSync(join(U, 'Assets/Prefabs'), { recursive: true });
mkdirSync(join(U, 'ProjectSettings'), { recursive: true });
writeFileSync(join(U, 'Assets/Scripts/ScoreKeeper.cs'),
  'namespace Game\n{\n    public class ScoreKeeper\n    {\n        private int _scoreMultiplier = 2;\n'
  + '        public int Apply(int points) { return points * _scoreMultiplier; }\n    }\n}\n');
writeFileSync(join(U, 'Assets/Scripts/ScoreKeeper.cs.meta'), `fileFormatVersion: 2\nguid: ${GUID}\n`);
writeFileSync(join(U, 'Assets/Scripts/Game.asmdef'), '{ "name": "Game" }\n');
writeFileSync(join(U, 'Assets/Prefabs/Player.prefab'), `MonoBehaviour:\n  m_Script: {fileID: 11500000, guid: ${GUID}, type: 3}\n`);
writeFileSync(join(U, 'Assets/Prefabs/Win.anim'), `AnimationClip:\n  m_Events:\n  - functionName: Apply\n    objectReferenceParameter: {guid: ${GUID}}\n`);
// An installer that BINDS a service — the third way a C# class reaches the running game, and the one
// that leaves no trace in any asset.
writeFileSync(join(U, 'Assets/Scripts/DeckService.cs'), 'namespace Game { public class DeckService {} }\n');
writeFileSync(join(U, 'Assets/Scripts/DeckService.cs.meta'), 'fileFormatVersion: 2\nguid: b1b2c3d4e5f60718293a4b5c6d7e8f91\n');
writeFileSync(join(U, 'Assets/Scripts/IDeckView.cs'), 'namespace Game { public interface IDeckView {} }\n');
writeFileSync(join(U, 'Assets/Scripts/IDeckView.cs.meta'), 'fileFormatVersion: 2\nguid: c1b2c3d4e5f60718293a4b5c6d7e8f92\n');
writeFileSync(join(U, 'Assets/Scripts/GameInstaller.cs'),
  'public class GameInstaller {\n'
  + '    void Install() {\n'
  + '        Container.BindInterfacesAndSelfTo<DeckService>().FromNew().AsSingle();\n'
  + '        Container.Bind<IDeckView>().WithId("x").FromInstance(v);\n'
  + '        var unrelated = new ScoreKeeper();\n'
  + '    }\n}\n');

// A method whose name only ENDS with the term the question yields — the shape that hid a real bug.
writeFileSync(join(U, 'Assets/Scripts/Clock.cs'),
  'namespace Game\n{\n    public class Clock\n    {\n        private int _scoreCount = 5;\n'
  + '        private int GetTimeBonus() => (int)(TimeLeft() / 60.0 * _scoreCount);\n    }\n}\n');

/** A TypeScript project where a string key joins two files with no import between them. */
const T = join(TMP, 'ts');
mkdirSync(join(T, 'src'), { recursive: true });
writeFileSync(join(T, 'package.json'), '{"name":"fx"}\n');
writeFileSync(join(T, 'tsconfig.json'), '{}\n');
writeFileSync(join(T, 'src/emit.ts'), 'export function go(s: Sock) {\n  s.emit("thing:done", { ok: true });\n}\n');
writeFileSync(join(T, 'src/handle.ts'), 'export function wire(s: Sock) {\n  s.on("thing:done", (p) => console.log(p));\n}\n');

// ── the project root is found from BELOW, and from `context` ─────────
//
// Observed in real use on a Unity project: `explore · generic`, 0 findings in 51 ms. `matches()` tests
// ONE directory, so a session started inside the project — or a question whose only locator was the
// `context` path the tool declared and never read — searched the wrong tree with the wrong explorer.
console.log('\nfinding the project when we are standing inside it');
{
  const { resolveProject, pathsIn } = await import('../dist/tools/explore/index.js');
  const deep = join(U, 'Assets/Scripts');
  ok(pickExplorer(deep).id === 'generic', 'testing the subdirectory ALONE still yields generic (the bug)');
  ok(resolveProject(deep).explorer.id === 'unity', 'walking up finds the Unity project from a subdirectory');
  ok(resolveProject(deep).root === U, '…and reports the project root, not the subdirectory', resolveProject(deep).root);
  ok(resolveProject(TMP).explorer.id === 'generic', 'a tree with no project marker stays generic');

  // `context` carries the path the model is actually asking about.
  const found = pathsIn(`the sprite vanishes, see ${join(U, 'Assets/Scripts/ScoreKeeper.cs')} line 12`);
  ok(found.includes(join(U, 'Assets/Scripts/ScoreKeeper.cs')), 'a real path inside prose is extracted from context');
  ok(pathsIn('/no/such/path/anywhere.cs').length === 0, 'a path that does not exist is not offered as a root');
}

// ── the search is index-backed in a git tree ─────────────────────────
//
// Not a micro-optimisation. The same explore call measured 0.4s here and 22 SECONDS on a macOS
// checkout of the same repository (BSD grep, cold APFS). A tool that promises sub-second and delivers
// 22 is not the same tool. Correctness first: the translation must return the same hits.
console.log('\ngit grep translation');
{
  const { asGitGrep } = await import('../dist/tools/explore/search.js');
  const plain = ['grep', '-rnI', '--exclude-dir=.git', '--include=*.cs', '-E', 'Foo', '.'];
  ok(asGitGrep(plain, TMP) === null, 'a directory that is not a git tree runs the original grep');

  const g = asGitGrep(plain, REPO);
  ok(g?.[0] === 'git' && g?.[1] === 'grep', 'inside a git tree it becomes git grep', (g ?? []).slice(0, 2).join(' '));
  ok(!g?.includes('-C'), 'no -C: the runner sets cwd, and -C sits where the read-only guard reads the subcommand');
  ok(g?.includes('--untracked'),
    'untracked files are searched — a file the operator has not committed is still code they asked about');
  ok(g?.includes('*.cs'), 'the --include becomes a pathspec');
  ok(g?.includes('Foo') && g?.includes('-E'), 'the pattern and its mode survive');

  const listing = asGitGrep(['grep', '-rlI', '--include=*.prefab', '-F', 'abc', '.'], REPO);
  ok(listing?.includes('-lI'), 'a files-only probe stays files-only');
  ok(listing?.includes('-F'), '…and a fixed-string probe stays fixed-string');

  ok(asGitGrep(['find', '.', '-name', 'x'], REPO) === null, 'find is not translated');
}

console.log('\nproject detection');
ok(pickExplorer(U).id === 'unity', 'a tree with Assets/ + ProjectSettings/ is unity', pickExplorer(U).id);
ok(pickExplorer(T).id === 'typescript', 'a tree with package.json + tsconfig.json is typescript', pickExplorer(T).id);
ok(pickExplorer(TMP).id === 'generic', 'anything else falls back to generic', pickExplorer(TMP).id);

// ── term extraction: the casing gap, and the key that must survive it ─
// ── "used in 0 assets" is only two thirds of an answer ───────────────
//
// A C# class reaches the running game three ways: a GUID reference from an asset, an animation event
// calling it by name, and a DI container binding it. The third leaves NO trace in any asset, so a
// service wired entirely by the container reported "used in 0 assets" — true, and indistinguishable
// from dead code.
console.log('\ncontainer bindings (the wiring that leaves no asset behind)');
{
  const { bindingsOf } = await import('../dist/tools/explore/projects/unity.js');

  const svc = await bindingsOf(U, 'Assets/Scripts/DeckService.cs');
  ok(svc.length === 1, 'a service bound by the container is found', `${svc.length} binding(s)`);
  ok(svc[0]?.file === 'Assets/Scripts/GameInstaller.cs', '…and the installer is named');
  ok(/BindInterfacesAndSelfTo<DeckService>/.test(svc[0]?.text ?? ''), '…with the binding line quoted');

  // Matching only `Bind<` — the obvious form — would have missed this one. Counted on a real
  // codebase: BindInterfacesTo (284) + BindInterfacesAndSelfTo (163) are 447 of 937 bindings.
  ok(!/^Container\.Bind</.test(svc[0]?.text ?? ''),
    'the form found here is NOT plain Bind< — matching only that misses nearly half of all bindings');

  const view = await bindingsOf(U, 'Assets/Scripts/IDeckView.cs');
  ok(view.some((b) => /Bind<IDeckView>/.test(b.text)), 'plain Bind<> is found too');

  const none = await bindingsOf(U, 'Assets/Scripts/Clock.cs');
  ok(none.length === 0, 'a class nobody binds reports nothing — mentioning it in an installer is not a binding');
  const merelyMentioned = await bindingsOf(U, 'Assets/Scripts/ScoreKeeper.cs');
  ok(merelyMentioned.length === 0,
    'a class CONSTRUCTED in an installer is not "injected" — a looser rule would call everything injected');
}

console.log('\nterm extraction (no model — this is a casing problem, not a reasoning one)');
{
  const t = extractTerms('how is the score multiplier applied');
  ok(t.identifiers.includes('scoreMultiplier'), 'English words become a camelCase identifier');
  ok(t.identifiers.includes('ScoreMultiplier'), '…and a PascalCase one');
  ok(t.identifiers.some((i) => /^Appl/.test(i)), 'an action verb becomes a method-name candidate');

  // A namespaced key is the highest-signal term there is, and the word splitter used to destroy it:
  // "where is chat:send handled" found NOTHING because the key became two words and then an
  // invented identifier.
  // PROSE IS NOT CODE. A capitalised English word used to count as a typed identifier, so a sentence
  // like "Find the source files … List every file … FILES:" searched for `Find`, `List` and `FILES`.
  // Measured on a real corpus build: 12s instead of 0.5s across 3,546 files, two junk seeds, and an
  // entire corpus built from them — paid for with OpenAI credits.
  const prose = extractTerms('Find the source files that implement bingo gameplay. List every file under FILES:');
  ok(!prose.identifiers.includes('Find'), 'a capitalised English verb is not an identifier');
  ok(!prose.identifiers.includes('List'), '…nor is List');
  ok(!prose.identifiers.includes('FILES'), '…nor is an all-caps prose word');
  const real = extractTerms('where is GameManager and _scoreCount and MAX_SIZE');
  ok(real.identifiers.includes('GameManager'), 'PascalCase with an internal case change IS an identifier');
  ok(real.identifiers.includes('_scoreCount'), '…and the _private convention');
  ok(real.identifiers.includes('MAX_SIZE'), '…and SCREAMING_SNAKE');

  const k = extractTerms('where is the chat:send socket event handled');
  ok(k.literals.includes('chat:send'), 'an unquoted namespaced key survives as a literal', k.literals.join(','));
  ok(!k.identifiers.includes('chatSendSocketEventHandled'),
    'a five-word run does NOT become an invented identifier');
}

// ── the term is a SUFFIX of the real symbol ──────────────────────────
//
// A REGRESSION TEST FOR A REAL MISS. "where is the time bonus calculated" yields `TimeBonus`, but the
// method is `GetTimeBonus()`. `\bTimeBonus` cannot match inside `GetTimeBonus` — both `t` and `T` are
// word characters, so there is no boundary there. On the real repository explore found the time
// bonus's CALL SITES and never its declaration, stopping one hop short of the defect, which was in
// the method body: the bonus scaled by a score that already carried the multiplier.
console.log('\na term that is only the SUFFIX of the symbol still finds the declaration');
{
  const out = await exploreExecute({ question: 'where is the time bonus calculated', cwd: U });
  ok(/Clock\.cs/.test(out), 'the file declaring GetTimeBonus is found from the term "time bonus"',
    'the definition probe requires a word boundary the compound name does not have');
  ok(/GetTimeBonus/.test(out), '…and the declaration line itself is quoted');
  ok(/defines/.test(out), '…labelled defines, not merely mentions');
}

// ── the no-lying guarantee ───────────────────────────────────────────
console.log('\ncannot lie: every quoted line is verified against the file on disk');
{
  const out = await exploreExecute({ question: 'how is score multiplier applied', cwd: U });
  const quoted = [...out.matchAll(/^ +(\d+) │ (.*)$/gm)];
  ok(quoted.length > 0, 'the answer quoted at least one line', `${quoted.length} line(s)`);

  // Pair every quoted line with the file heading above it and re-read that exact line.
  const lines = out.split('\n');
  let checked = 0;
  let mismatched = 0;
  let currentFile = null;
  for (const l of lines) {
    const h = /^ {2}\[[a-z-]+\] ([^\s:]+)(?::(\d+))?/.exec(l);
    if (h) { currentFile = h[1]; continue; }
    const q = /^ +(\d+) │ (.*)$/.exec(l);
    if (!q || !currentFile) continue;
    const n = Number(q[1]);
    let src;
    try { src = readFileSync(join(U, currentFile), 'utf-8').split('\n'); } catch { continue; }
    checked++;
    const actual = (src[n - 1] ?? '').slice(0, 160);
    if (actual.trimEnd() !== q[2].replace(/…$/, '').trimEnd()) mismatched++;
  }
  ok(checked > 0, 'quoted lines were traceable to a file heading', `${checked} checked`);
  ok(mismatched === 0, 'EVERY quoted line matches the file at that line number', `${mismatched} mismatch(es)`);
  ok(!/\b(probably|likely|appears to|seems|I think|suggests)\b/i.test(out),
    'the answer contains no hedging language — there is no prose generator to produce it');
}

// ── determinism ──────────────────────────────────────────────────────
console.log('\ndeterministic: no model, so no sampling');
{
  const a = await exploreExecute({ question: 'how is score multiplier applied', cwd: U });
  const b = await exploreExecute({ question: 'how is score multiplier applied', cwd: U });
  const strip = (s) => s.replace(/· \d+ms/, '· Nms');
  ok(strip(a) === strip(b), 'the same question twice gives a byte-identical answer');
}

// ── Unity glue: the link that is a hash, not a name ──────────────────
console.log('\nunity: GUID references, animation clips, asmdef');
{
  ok(guidOf(join(U, 'Assets/Scripts/ScoreKeeper.cs')) === GUID, 'the guid is read from the sibling .meta');
  ok(asmdefOf(join(U, 'Assets/Scripts/ScoreKeeper.cs'), U).endsWith('Game.asmdef'), 'the enclosing asmdef is found');

  const out = await exploreExecute({ question: 'ScoreKeeper', cwd: U });
  ok(/Player\.prefab/.test(out), 'a prefab referencing the script BY GUID is reported', 'grep for the class name finds no prefab');
  ok(/Win\.anim/.test(out), 'an animation clip referencing it is reported too');
  ok(/anim-event/.test(out), '…and labelled anim-event, because a clip calls methods by NAME STRING');
  ok(/Game\.asmdef/.test(out), 'the assembly it compiles into is stated');

  // The negative result is an answer, and it must never outrank real code.
  const idx = out.indexOf('no asset references');
  const firstCode = out.search(/│/);
  ok(idx === -1 || firstCode === -1 || firstCode < idx,
    'a "not wired to anything" line never sorts above actual code');
}

// ── TypeScript glue: the string key with no import edge ──────────────
console.log('\ntypescript: string keys joining files with no import between them');
{
  const out = await exploreExecute({ question: 'thing:done', cwd: T });
  ok(/emit\.ts/.test(out) && /handle\.ts/.test(out),
    'both ends of a string-keyed dispatch are found', 'neither file imports the other');
  ok(/string-key/.test(out), '…and labelled string-key');
}

// ── nothing found is an ANSWER ───────────────────────────────────────
console.log('\n"nothing found" is a real answer, and a SMALL one');
{
  const out = await exploreExecute({ question: 'zzzznotarealsymbolzzzz', cwd: T });
  ok(/NOTHING FOUND/.test(out), 'it says so plainly');
  ok(!/│/.test(out), 'and quotes nothing, rather than dumping whatever it had');
  // The old tool answered a miss with a digest of `ls -la`; the replacement must not answer a miss
  // with thousands of characters of probe transcript either.
  ok(out.length < 1200, 'the empty answer stays small enough to be worth reading', `${out.length} chars`);
}

// ── read-only by construction ────────────────────────────────────────
console.log('\nread-only: enforced by the runner, not by an allow-list of prefixes');
{
  const refuses = async (argv, why) => {
    try { await runProbe(argv, TMP); ok(false, why, 'it RAN'); }
    catch (e) { ok(/refusing/.test(String(e.message)), why, String(e.message).slice(0, 60)); }
  };
  await refuses(['rm', '-rf', '/tmp/x'], 'refuses a binary that is not in the read-only set');
  await refuses(['sh', '-c', 'echo hi'], 'refuses a shell outright');
  await refuses(['git', 'push'], 'refuses a git subcommand that writes');
  await refuses(['find', '.', '-delete'], 'refuses find -delete');
  await refuses(['find', '.', '-exec', 'rm', '{}', ';'], 'refuses find -exec');

  // Shell metacharacters are DATA here: argv goes straight to execve, so there is nothing to inject
  // into. The previous tool handed model-authored strings to `sh -lc` behind a prefix check that
  // `grep foo . ; echo INJECTED` walked straight through.
  const r = await runProbe(['grep', '-rn', 'a; echo INJECTED', '.'], TMP);
  ok(r.ok && !r.lines.some((l) => /INJECTED/.test(l)),
    'a shell metacharacter in a pattern is searched for, not executed');
}

// ── and no model anywhere in the package ─────────────────────────────
console.log('\nno model in the tool');
{
  const files = ['index.ts', 'terms.ts', 'search.ts', 'rank.ts', 'format.ts',
    'projects/unity.ts', 'projects/typescript.ts', 'projects/generic.ts'];
  let usesLlm = [];
  for (const f of files) {
    const src = readFileSync(join(REPO, 'src/tools/explore', f), 'utf-8');
    if (/toolLlm\s*\(/.test(src)) usesLlm.push(f);
  }
  ok(usesLlm.length === 0, 'no file in explore/ calls the model', usesLlm.join(', '));
}

/**
 * THE DESIGN LEADS, when the project has one.
 *
 * Everything above is evidence about what the code IS. A naamah `.puml` says what it is FOR — the intent
 * of each member, and which domains may reference which — and that is better evidence about intent than
 * any amount of grep output. Read after a list of file spans it is a footnote; read before them it is the
 * frame. What must hold: it goes FIRST, it is FILTERED to the question (a whole design dumped into every
 * prompt is the distractor case `planGrounding` was measured on), the domains are always there, and a
 * project with no design gets no block at all.
 */
console.log('\nthe naamah design, read first');
{
  const naama = await import(`file://${join(DIST, 'naama/index.js')}`);
  const P = join(TMP, 'designed');
  mkdirSync(join(P, 'Assets'), { recursive: true });
  mkdirSync(join(P, 'ProjectSettings'), { recursive: true });
  mkdirSync(join(P, 'docs'), { recursive: true });
  writeFileSync(join(P, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n');
  writeFileSync(join(P, 'Assets', 'WidgetController.cs'), 'public sealed class WidgetController { }\n');

  const doc = naama.emptyDoc('Widget design');
  for (const line of [
    'domain ui refs=core',
    'domain core refs=NONE sealed',
    'type WidgetController : class @ ui — drives the milestone circles',
    'member WidgetController.OnCounterChanged(CounterState c) — plays Filling ONCE per newly lit slot, never looped',
    'type CounterState : struct @ core — how many milestones are lit',
    'member CounterState.Value : int — never above Target',
    'type AudioBus : class @ core',
    'edge WidgetController -> CounterState : dependency',
  ]) naama.applyLine(doc, line);
  const designPath = join(P, 'docs', 'design.puml');
  naama.saveDoc(designPath, doc);

  const matched = await exploreExecute({ question: 'what does WidgetController do when the counter changes?', cwd: P });
  ok(matched.startsWith('design ·'), 'the design block is the FIRST thing in the answer', matched.slice(0, 24));
  ok(matched.indexOf('design ·') < matched.indexOf('explore ·'), 'ahead of the localization, not under it');
  ok(/plays Filling ONCE per newly lit slot/.test(matched),
    'a matched type carries its members WITH their intent — the half the code cannot state');
  ok(/domain core — refs NONE · sealed/.test(matched),
    'the domains and what they may reference are always included — that is the constraint broken blindly');
  ok(!/class AudioBus/.test(matched),
    'a type the question is not about is NOT described — a dumped design is the distractor case');
  ok(matched.includes(designPath), 'and the file is named, so the rest can be read');

  const unmatched = await exploreExecute({ question: 'where is the network retry policy configured?', cwd: P });
  ok(/nothing in the design matches this question/.test(unmatched),
    'when nothing matches, it says so rather than describing something irrelevant');
  ok(/WidgetController@ui · AudioBus@core|AudioBus@core/.test(unmatched),
    'and gives the type names as an INDEX, so a name can be asked for next');
  ok(!/plays Filling ONCE/.test(unmatched), 'without any member bodies — an index is not the document');

  const plain = join(TMP, 'undesigned');
  mkdirSync(join(plain, 'Assets'), { recursive: true });
  mkdirSync(join(plain, 'ProjectSettings'), { recursive: true });
  writeFileSync(join(plain, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n');
  writeFileSync(join(plain, 'Assets', 'WidgetController.cs'), 'public sealed class WidgetController { }\n');
  const none = await exploreExecute({ question: 'what does WidgetController do?', cwd: plain });
  ok(!none.includes('design ·'), 'a project with no design gets no block — silence, not a placeholder');

  // A PlantUML file that is not a naamah design must not be read as one: it declares no domains and no
  // types, so a sequence diagram someone committed is not mistaken for a contract.
  writeFileSync(join(plain, 'flow.puml'), '@startuml\nAlice -> Bob: hello\n@enduml\n');
  const notADesign = await exploreExecute({ question: 'what does WidgetController really do?', cwd: plain });
  ok(!notADesign.includes('design ·'),
    'an ordinary PlantUML diagram is not a design — no domains, no types, no block');
}

rmSync(TMP, { recursive: true, force: true });
console.log(fails === 0 ? '\nexplore check: ok' : `\nexplore check: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
