#!/usr/bin/env node
/**
 * check-weave — the decision tree of `ayin watch --weave`, against a real repo, with no model.
 *
 * `npm run check:weave` (needs a build first). It builds a throwaway git repo in the OS temp dir with
 * a design and some source, then drives `weaveRepo` through every branch by injecting the prompt
 * builder AND the runner — so no agent is ever launched and the whole thing runs offline in a second.
 *
 * WHY THESE ASSERTIONS. Everything expensive about this feature hangs off one question — *is there a
 * surface delta* — and every way of getting it wrong is silent:
 *
 *   - a body edit that looks like a delta spawns a headless agent per save, forever;
 *   - a delta that looks like nothing lets the diagram rot with the daemon reporting success;
 *   - a rename read as delete+add drops a designed type and its intent prose, then re-adds it bare;
 *   - a snapshot advanced before the weave is verified turns one power cut into permanent drift;
 *   - a private helper treated as a surface puts implementation detail on an architecture diagram.
 *
 * None of those fails a typecheck and none of them throws. They are only visible as assertions.
 */

// Declare ourselves headless BEFORE importing dist: the weave module reaches the naama/entangle
// layers, and ui/index.ts builds real blessed widgets at module load unless HEADLESS is set.
if (!process.argv.includes('-p')) process.argv.push('-p');

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = mkdtempSync(join(tmpdir(), 'ayin-weave-'));

/**
 * A THROWAWAY HOME, set before anything from `dist/` is imported.
 *
 * The weave snapshot lives under `~/.ayin-cli/watch`, and the operator's own daemon is reading and
 * writing that file. A gate that clears it to get a clean slate would delete the real snapshots of
 * every repo they weave, and the damage is invisible: the next pass just treats each one as new. So
 * `$HOME` is moved somewhere disposable first — `os.homedir()` honours it, and the module resolves
 * its paths at import time, which is why this has to happen above the imports.
 */
const HOME = mkdtempSync(join(tmpdir(), 'ayin-weave-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const STATE = join(HOME, '.ayin-cli', 'watch', 'weave-state.json');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
const write = (rel, body) => {
  mkdirSync(dirname(join(REPO, rel)), { recursive: true });
  writeFileSync(join(REPO, rel), body);
};

// ── a repo with a design and matching TypeScript ─────────────────────

git('init', '-q', '-b', 'main', '.');
git('config', 'user.email', 'weave@test'); git('config', 'user.name', 'weave');
write('package.json', JSON.stringify({ name: 'weave-fixture', version: '1.0.0' }, null, 2));

write('design.puml', `@startuml
' naamah:title Rewards
' naamah:domain weave-fixture refs=NONE sealed
package "weave-fixture" {
  class RewardService {
    +grant(id)  — hands one reward out
    -live : Entry[]
  }
  interface Clock {
    +now()
  }
}
RewardService ..> Clock
@enduml
`);

write('src/reward-service.ts', `export class RewardService {
  private live: Entry[] = [];
  grant(id: string): void {}
}
`);
write('src/clock.ts', `export interface Clock {
  now(): number;
}
`);
git('add', '-A'); git('commit', '-qm', 'baseline');

const { weaveRepo, discoverDesign, registerWeave, unregisterWeave, weaveRepos } = await import(join(ROOT, 'dist/weave/index.js'));
const { computeDelta, typesIn, renderDelta } = await import(join(ROOT, 'dist/weave/delta.js'));

// No agent is ever launched here. The prompt builder records what it was handed, and `run` stands in
// for the headless ayin — so every branch below is exercised with no model, no network and no minutes.
// `edits` lets the stub behave like a weaver that did, or did not, do its job.
let lastPrompt = null;
let ran = 0;
const spy = (edits = null) => ({
  prompt: ({ design, delta }) => { lastPrompt = { design, delta }; return 'stub'; },
  run: async () => { ran++; if (edits) edits(); return { code: 0, signal: null }; },
});

// ── the design this tree owns ────────────────────────────────────────

ok(await discoverDesign(REPO) === 'design.puml', 'the .puml that declares a type is found as the design');
write('notes.puml', '@startuml\nAlice -> Bob: hello\n@enduml\n');
ok(await discoverDesign(REPO) === 'design.puml',
  'a sequence diagram declares no type and is not mistaken for the design');
unlinkSync(join(REPO, 'notes.puml'));

// ── first sight is a baseline, never a job ───────────────────────────

{
  const r = await weaveRepo(REPO, 'design.puml', spy());
  ok(r.status === 'baselined', 'a repo seen for the first time is BASELINED', r.status);
  ok(lastPrompt === null, 'and nothing is spawned for it — a years-old diagram is not one prompt');
  ok(/already matches/.test(r.note), 'a design that matches says so', r.note);
}

/**
 * One weave, from a still tree.
 *
 * TWO calls, deliberately: the first sees a new surface and starts the quiet clock, the second finds
 * the same surface a minute later and releases. That is the behaviour worth pinning — a clock started
 * at the first keystroke and never restarted would fire in the middle of a refactor, which is the one
 * thing the quiet window exists to prevent.
 */
let clock = Date.now();
const settle = async (deps) => {
  clock += 10 * 60_000;
  const first = await weaveRepo(REPO, 'design.puml', deps, clock);
  const second = await weaveRepo(REPO, 'design.puml', deps, clock + 60_000);
  return { first, second };
};

// ── a body edit is not a surface change ──────────────────────────────

write('src/reward-service.ts', `export class RewardService {
  private live: Entry[] = [];
  grant(id: string): void { this.live.push({ id }); }
}
`);
{
  const deps = spy();
  const { first, second } = await settle(deps);
  ok(first.status === 'quiet', 'a change is seen, and the tree must settle before anything is spent', first.status);
  ok(second.status === 'no-delta', 'once settled, a method BODY edit is not a delta', `${second.status}: ${second.note}`);
  ok(lastPrompt === null && ran === 0, 'so no model, and no run, is spent on it');
}

// ── a private member is not a surface ────────────────────────────────

write('src/reward-service.ts', `export class RewardService {
  private live: Entry[] = [];
  private cache = new Map();
  grant(id: string): void {}
}
`);
{
  const { second } = await settle(spy());
  ok(second.status === 'no-delta', 'a new PRIVATE member is not a design change', `${second.status}: ${second.note}`);
  ok(ran === 0, 'and still nothing has been run');
}

// ── a new public member IS drift, and the run is VERIFIED ────────────

write('src/reward-service.ts', `export class RewardService {
  private live: Entry[] = [];
  grant(id: string): void {}
  revoke(id: string): void {}
}
`);
{
  // A weaver that does nothing. The design still differs afterwards, so this must NOT be called done.
  lastPrompt = null;
  const { second } = await settle(spy());
  ok(second.status === 'incomplete',
    'a run that left the delta in place is INCOMPLETE — the exit code is not evidence', `${second.status}: ${second.note}`);
  ok(ran === 1, 'exactly one run was spent', String(ran));
  ok(lastPrompt?.delta.drifted.some((d) => d.name === 'RewardService' && d.gained.includes('revoke')),
    'and it was TOLD which member drifted, not asked to find it');
  ok(lastPrompt?.delta.added.length === 0, 'a drifted type is not also reported as added');
  const st = JSON.parse(readFileSync(STATE, 'utf-8'));
  ok(st[REPO]?.attempts === 1, 'the failed attempt is counted', String(st[REPO]?.attempts));
  ok(st[REPO]?.files?.['src/reward-service.ts']?.types?.length === 1
    && !/revoke/.test(JSON.stringify(st[REPO].files['src/reward-service.ts'])),
    'and the snapshot was NOT advanced — a power cut here recomputes the same delta, it does not lose it');
}

// ── a weaver that actually writes the fact is WOVEN ──────────────────

{
  ran = 0;
  const before = JSON.parse(readFileSync(STATE, 'utf-8'))[REPO].files['src/reward-service.ts'].hash;
  const { second } = await settle(spy(() => {
    // What the real headless run does through the naama tool, done here with a string edit.
    const p = join(REPO, 'design.puml');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('+grant(id)  — hands one reward out',
      '+grant(id)  — hands one reward out\n    +revoke(id)  — takes it back'));
  }));
  ok(second.status === 'woven', 'a run that closed the delta is WOVEN', `${second.status}: ${second.note}`);
  ok(ran === 1, 'in one run', String(ran));
  const st = JSON.parse(readFileSync(STATE, 'utf-8'));
  ok(st[REPO].files['src/reward-service.ts'].hash !== before,
    'and only NOW does the snapshot advance');
  ok((st[REPO].attempts ?? 0) === 0, 'the attempt counter is cleared by success', String(st[REPO].attempts));
  // naamah names its output after the input and writes it into the process's CWD. A daemon's cwd is
  // wherever it was launched, so left implicit the page lands nowhere near the design — measured: it
  // landed in ayin's own repo root.
  ok(existsSync(join(REPO, 'design.html')), 'the rendered page lands BESIDE the design, not in the cwd');
  ok(!existsSync(join(ROOT, 'design.html')), 'and never in the process working directory');
  const again = await weaveRepo(REPO, 'design.puml', spy(), clock + 20 * 60_000);
  ok(again.status === 'no-delta', 'and a woven repo is quiet on the next pass', `${again.status}: ${again.note}`);
}

// ── the delta itself: added, removed, moved ──────────────────────────

const design = (await import(join(ROOT, 'dist/naama/index.js'))).parsePuml(readFileSync(join(REPO, 'design.puml'), 'utf-8'));
const surfaceOf = (rel) => typesIn(rel, readFileSync(join(REPO, rel), 'utf-8'), join(REPO, rel));

{
  write('src/ghost.ts', 'export class Ghost {\n  haunt(): void {}\n}\n');
  const d = computeDelta({ design, current: surfaceOf('src/ghost.ts'), goneFrom: [] });
  ok(d.added.length === 1 && d.added[0].name === 'Ghost', 'a type the design does not declare is ADDED');
  ok(d.added[0].members.includes('haunt'), 'with its public surface');
  ok(d.added[0].unit === 'weave-fixture', 'and the code unit it sits in, as a hint about its domain');
  unlinkSync(join(REPO, 'src/ghost.ts'));
}

{
  const d = computeDelta({ design, current: [], goneFrom: [{ file: 'src/clock.ts', types: ['Clock'] }] });
  ok(d.removed.length === 1 && d.removed[0].name === 'Clock', 'a designed type whose file is gone is REMOVED');
}

{
  // The case that would silently destroy intent prose: a rename or a move is delete + add.
  const d = computeDelta({
    design,
    current: surfaceOf('src/reward-service.ts'),
    goneFrom: [{ file: 'src/old-reward-service.ts', types: ['RewardService'] }],
  });
  ok(d.removed.length === 0, 'a type that reappears in another file is NOT dropped from the design');
  ok(d.moved.length === 1 && d.moved[0].name === 'RewardService', 'it is reported as MOVED instead');
}

{
  const lines = renderDelta({ added: [], removed: [], drifted: [], moved: [] });
  ok(lines.added === '(none)' && lines.removed === '(none)',
    'an empty section renders as (none) — an absent heading reads as an omission to fill in');
}

{
  // The false-removal trap. `SurfaceLanguage` parses line by line, so a one-line body reads as having
  // no members at all — and believing it would send the weaver to delete design facts that are true.
  write('src/one-liner.ts', 'export class Clock { now(): number { return 0; } }\n');
  const one = surfaceOf('src/one-liner.ts');
  ok(one[0]?.members.length === 0, 'a one-line class body parses as having no members (a parser limit)');
  const d = computeDelta({ design, current: one, goneFrom: [] });
  ok(d.drifted.length === 0,
    'so a type with ZERO parsed members claims NO member drift — unknown is not the same as empty');
  unlinkSync(join(REPO, 'src/one-liner.ts'));
}

// ── registration ─────────────────────────────────────────────────────

const REPOS = join(REPO, 'repos.json');
{
  writeFileSync(REPOS, JSON.stringify({ [REPO]: { installedAt: 'x' } }, null, 2));
  const shown = registerWeave(REPOS, REPO, join(REPO, 'design.puml'));
  ok(shown === 'design.puml', 'an absolute design path is stored repo-RELATIVE so a moved checkout still works', shown);
  const entry = JSON.parse(readFileSync(REPOS, 'utf-8'))[REPO];
  ok(entry.installedAt === 'x', 'and registering a weave does not clobber the rest of the watch entry');
  ok(weaveRepos(REPOS).length === 1, 'the daemon sees exactly the repos that asked for it');
  writeFileSync(REPOS, JSON.stringify({ [REPO]: { installedAt: 'x' }, '/nope': { installedAt: 'y' } }, null, 2));
  ok(weaveRepos(REPOS).length === 0, 'a watched repo that did NOT ask is never woven');
}

{
  // The footgun: re-running `ayin watch --repo <path>` to reinstall a hook must not switch weaving
  // off. installHook MERGES its entry, and this is the assertion that keeps it merging.
  const src = readFileSync(join(ROOT, 'src/watch.ts'), 'utf-8');
  ok(/repos\[repo\] = \{ \.\.\.\(repos\[repo\] \?\? \{\}\), installedAt/.test(src),
    'installHook merges the repos.json entry rather than replacing it');
}

{
  writeFileSync(REPOS, JSON.stringify({ [REPO]: { installedAt: 'x', weave: { design: 'design.puml' } } }, null, 2));
  ok(unregisterWeave(REPOS, REPO), 'unwatch deregisters the weave');
  ok(JSON.parse(readFileSync(REPOS, 'utf-8'))[REPO].installedAt === 'x', 'leaving the watch entry itself alone');
  const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf-8')) : {};
  ok(st[REPO] === undefined,
    'and drops the snapshot with it — a stale one would weave a months-old delta on re-registration');
}

// ── the prompt is a file, and it carries the delta ───────────────────

{
  const src = readFileSync(join(ROOT, 'prompts/watch/weaveRun.txt'), 'utf-8');
  for (const v of ['{{DESIGN}}', '{{ADDED}}', '{{REMOVED}}', '{{DRIFTED}}', '{{MOVED}}']) {
    ok(src.includes(v), `weaveRun.txt interpolates ${v}`);
  }
  ok(/naama/.test(src), 'and points the run at the naama tool rather than at an editor');
  const shouts = (src.match(/\b(MUST|NEVER|ALWAYS)\b/g) ?? []).length;
  ok(shouts <= 3, `at most three emphasis markers — when everything shouts, nothing does (${shouts})`);
}

// ── a design that is not there ───────────────────────────────────────

{
  const bare = mkdtempSync(join(tmpdir(), 'ayin-weave-bare-'));
  execFileSync('git', ['-C', bare, 'init', '-q', '-b', 'main', '.'], { stdio: 'ignore' });
  const r = await weaveRepo(bare, undefined, spy());
  ok(r.status === 'no-design', 'a tree with no design says so instead of inventing one', r.status);
  rmSync(bare, { recursive: true, force: true });
}

rmSync(REPO, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\nweave check: ${fails} FAILURE(S)\n` : '\nweave check: ok\n');
process.exit(fails ? 1 : 0);
