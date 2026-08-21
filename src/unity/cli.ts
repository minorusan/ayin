/**
 * unity/cli.ts — `ayin unity …`: the Unity toolkit from a shell, curt on purpose.
 *
 * ONE NAMESPACE, because these three answer the same operator's question in one session — what is this
 * prefab wired to, change that wiring, did the tests still pass — and three top-level subcommands would
 * put Unity vocabulary in front of everyone who never opens Unity. `ayin --help unity` is the verbose
 * page; everything printed here is deliberately short enough to read without scrolling.
 *
 * NOTHING NEW UNDERNEATH. `prefab` and `prefab_edit` run the tools the agent uses (`src/prefab/`), and
 * `test` selects with the asmdef index and executes through `runSelection` — the same path `/testrun`
 * takes, so a run from the shell and a run from the TUI cannot disagree about what passed. The only thing
 * this file adds is SELECTION BY ASSEMBLY NAME: `/testrun` picks assemblies from a corpus domain, which is
 * the right default when you know the feature and not the assembly, and the wrong one when you know
 * exactly which assembly you just touched.
 *
 * CURT MEANS: on success, one line. On failure, the failed tests and nothing else. `-v` is the full
 * report, and the exit code is the answer for anything scripting it.
 */

import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  buildAsmdefIndex, compiledState, isUnityProject, unityVersion, type Asmdef,
} from '../testrun/asmdef.js';
import { formatReport, runSelection, type Selection } from '../testrun/index.js';
import { buildPrefabMap, isInspectable } from '../prefab/map.js';
import { renderPrefabTree } from '../prefab/render.js';
import { projectRootFor, setPrefabProperty } from '../prefab/edit.js';
import { buildAnimatorMap, isAnimatorController } from '../animator/map.js';

const USAGE = `unity — Unity assets and tests, without opening the Editor

  ayin unity prefab <file>              hierarchy, components, every guid resolved
  ayin unity animator <file.controller> states, transitions, exit time, clip overlap
  ayin unity prefab_edit <file> --property P (--value V | --asset NAME) [--object O] [--component C]
  ayin unity test <Asm1,Asm2>           run those test assemblies · --failed · -v
  ayin unity test --assemblies          what can be run, and which are PlayMode

ayin --help unity for the details.
`;

/** `--flag value` and `--flag=value`, plus bare flags. Positionals keep their order. */
function parseArgs(argv: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) { rest.push(a); continue; }
    const bare = a.replace(/^--?/, '');
    const eq = bare.indexOf('=');
    if (eq !== -1) { flags[bare.slice(0, eq)] = bare.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('-')) { flags[bare] = next; i++; }
    else flags[bare] = 'true';
  }
  return { flags, rest };
}

/** Small and local: the namespace's four subcommands are not in the help database as separate entries. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return a.length || b.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}

const out = (s: string): void => { process.stdout.write(s.endsWith('\n') ? s : `${s}\n`); };
const err = (s: string): void => { process.stderr.write(s.endsWith('\n') ? s : `${s}\n`); };

const abs = (p: string): string => (isAbsolute(p) ? p : resolve(process.cwd(), p));

/** The Unity project this command is about, or '' — every subcommand needs one. */
function projectRoot(hint: string): string {
  const fromFile = hint ? projectRootFor(abs(hint)) : '';
  if (fromFile) return fromFile;
  return isUnityProject(process.cwd()) ? process.cwd() : '';
}

async function prefabCmd(argv: string[]): Promise<number> {
  const { flags, rest } = parseArgs(argv);
  const file = rest[0];
  if (!file) { err('ayin unity prefab <file.prefab|.unity|.asset>'); return 1; }
  const path = abs(file);
  if (!existsSync(path)) { err(`not found: ${path}`); return 1; }
  if (!isInspectable(path)) { err(`${basename(path)} is not a .prefab, .unity or .asset`); return 1; }
  const root = projectRoot(file);
  if (!root) { err('not inside a Unity project (no Assets/ + ProjectSettings/ above this file)'); return 1; }
  const depth = flags.depth === undefined ? 3 : Math.max(0, Math.min(8, Number(flags.depth) || 0));
  const map = await buildPrefabMap(path, { root, depth });
  out(flags.json === 'true'
    ? JSON.stringify(map, null, 2)
    : renderPrefabTree(map, { everything: flags.scalars === 'true' }));
  return 0;
}

async function animatorCmd(argv: string[]): Promise<number> {
  const { flags, rest } = parseArgs(argv);
  const file = rest[0];
  if (!file) { err('ayin unity animator <file.controller>'); return 1; }
  const path = abs(file);
  if (!existsSync(path)) { err(`not found: ${path}`); return 1; }
  if (!isAnimatorController(path)) { err(`${basename(path)} is not a .controller`); return 1; }
  const root = projectRoot(file);
  if (!root) { err('not inside a Unity project'); return 1; }
  const map = await buildAnimatorMap(path, { root });
  if (flags.json === 'true') { out(JSON.stringify(map, null, 2)); return 0; }

  // Curt: the states with their clips, and the transitions whose numbers are the answer.
  for (const layer of map.layers) {
    out(`${layer.name}  ${layer.states.length} state(s)  default=${layer.defaultState || '(none)'}`);
    for (const s of layer.states) {
      const clip = s.clip.asset?.name ?? s.clip.blendTree ?? (s.clip.missing ? 'MISSING' : '(no motion)');
      const len = s.clip.lengthSeconds !== undefined ? ` ${s.clip.lengthSeconds.toFixed(2)}s` : '';
      out(`  ${s.isDefault ? '▶' : ' '} ${s.name}  ${clip}${len}${s.clip.loops ? ' loop' : ''}`);
      for (const t of s.transitions) {
        const when = t.conditions.length
          ? t.conditions.map((c) => `${c.parameter} ${c.mode} ${c.threshold}`).join(' AND ')
          : (t.hasExitTime ? 'on exit time' : 'immediately');
        const fade = t.overlap.clipsOverlap
          ? `fade ${t.overlap.seconds !== undefined ? `${t.overlap.seconds.toFixed(2)}s` : `${t.duration} norm`}`
          : 'cut';
        out(`      → ${t.to}  ${when}  ${t.hasExitTime ? `exit ${t.exitTime}` : 'NO exit time'}  ${fade}`);
      }
    }
  }
  if (map.findings.length) {
    out('');
    for (const f of map.findings) out(`  ! ${f}`);
  }
  return 0;
}

async function prefabEditCmd(argv: string[]): Promise<number> {
  const { flags, rest } = parseArgs(argv);
  const file = rest[0];
  if (!file || !flags.property) {
    err('ayin unity prefab_edit <file> --property P (--value V | --asset NAME) [--object O] [--component C]');
    return 1;
  }
  const path = abs(file);
  if (!existsSync(path)) { err(`not found: ${path}`); return 1; }
  const root = projectRoot(file);
  if (!root) { err('not inside a Unity project'); return 1; }
  const result = await setPrefabProperty({
    file: path, root,
    object: flags.object, component: flags.component, property: flags.property,
    value: flags.value, asset: flags.asset,
  });
  if (!result.ok) { err(result.error); return 1; }
  out(`${result.target} · ${result.rule}`);
  out(result.diff);
  return 0;
}

/** Test assemblies, and whether their compiled DLL can be trusted. */
function testAssemblies(repo: string): Array<{ asmdef: Asmdef; state: string }> {
  const index = buildAsmdefIndex(repo);
  const tests = index.all.filter((a) => a.isTest);
  const compiled = compiledState(repo, tests);
  return tests.map((asmdef) => {
    const c = compiled.find((x) => x.asmdef.name === asmdef.name);
    const state = !c?.dll ? 'never compiled' : c.stale ? 'stale' : 'compiled';
    return { asmdef, state };
  });
}

async function testCmd(argv: string[]): Promise<number> {
  const { flags, rest } = parseArgs(argv);
  const repo = process.cwd();
  if (!isUnityProject(repo)) { err(`${repo} is not a Unity project`); return 1; }

  const all = testAssemblies(repo);
  if (flags.assemblies === 'true' || (!rest.length && !flags.all)) {
    if (!all.length) { out('no test assemblies in this project'); return 0; }
    out(`${all.length} test assembl${all.length === 1 ? 'y' : 'ies'} · Unity ${unityVersion(repo) ?? '?'}`);
    for (const { asmdef, state } of all) {
      out(`  ${asmdef.editorOnly ? 'EditMode' : 'PlayMode'}  ${asmdef.name}  ${state}`);
    }
    out('');
    out('ayin unity test A,B   (comma-separated, names above)');
    return 0;
  }

  const wanted = rest.join(' ').split(',').map((s) => s.trim()).filter(Boolean);
  const picked: Asmdef[] = [];
  for (const name of wanted) {
    const hit = all.find((a) => a.asmdef.name.toLowerCase() === name.toLowerCase());
    if (hit) { picked.push(hit.asmdef); continue; }
    // A near-miss is the common typo, and guessing which assembly was meant would run the wrong tests.
    const near = all.filter((a) => a.asmdef.name.toLowerCase().includes(name.toLowerCase()))
      .map((a) => a.asmdef.name);
    err(`no test assembly named "${name}"${near.length ? ` — did you mean: ${near.join(', ')}?` : ''}`);
    err('ayin unity test --assemblies to list them');
    return 1;
  }

  const selection: Selection = {
    // The domains field is what the report prints as "what was asked for"; the assemblies ARE the ask
    // here, so it says so rather than inventing a domain name nobody typed.
    domains: [picked.map((a) => a.name).join(', ')],
    files: [],
    assemblies: picked,
    guessed: false,
  };
  const result = await runSelection(repo, selection);

  if (flags.v === 'true' || flags.verbose === 'true') {
    out(formatReport(result));
    return result.outcomes.some((o) => o.failed > 0 || o.notRun) ? 1 : 0;
  }

  // Curt. One line when everything passed; only what failed when something did.
  const failedCases = result.outcomes.flatMap((o) =>
    o.cases.filter((c) => c.outcome === 'failed').map((c) => ({ assembly: o.assembly, ...c })));
  const notRun = result.outcomes.filter((o) => o.notRun);
  const passed = result.outcomes.reduce((n, o) => n + o.passed, 0);
  const skipped = result.outcomes.reduce((n, o) => n + o.skipped, 0);

  if (!result.outcomes.length) { out(result.note ?? 'nothing ran'); return 1; }
  for (const o of notRun) out(`NOT RUN  ${o.assembly} — ${o.notRun}`);
  for (const c of failedCases) {
    out(`FAIL  ${c.name}`);
    if (c.message) out(`      ${c.message.split('\n')[0]}`);
  }
  if (!failedCases.length && !notRun.length) {
    out(`ok · ${passed} passed${skipped ? ` · ${skipped} skipped` : ''} · ${result.mode === 'prebuilt' ? 'prebuilt DLLs' : 'batch mode'}`);
    return 0;
  }
  out(`${failedCases.length} failed · ${passed} passed${notRun.length ? ` · ${notRun.length} assembly(ies) NOT RUN` : ''}`);
  return 1;
}

export async function runUnityCli(argv: string[]): Promise<number> {
  const sub = argv[0] ?? '';
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    out(USAGE);
    return sub ? 0 : 1;
  }
  switch (sub) {
    case 'prefab': return prefabCmd(argv.slice(1));
    case 'prefab_edit': case 'prefab-edit': return prefabEditCmd(argv.slice(1));
    case 'animator': return animatorCmd(argv.slice(1));
    case 'test': return testCmd(argv.slice(1));
    default: {
      // Same rule as the top-level dispatch: a typo names itself and what was probably meant, rather
      // than printing a usage block and leaving the reader to diff it against what they typed.
      const known = ['prefab', 'prefab_edit', 'animator', 'test'];
      const near = known.filter((k) => k.startsWith(sub) || sub.startsWith(k) || editDistance(k, sub) <= 2);
      err(`ayin unity: no subcommand "${sub}"${near.length ? ` — did you mean ${near.join(' · ')}?` : ''}`);
      out(USAGE);
      return 1;
    }
  }
}

/**
 * `/unity-test A,B` — the same selection and the same report, printed into the chat.
 *
 * Shares `testCmd`'s selection deliberately: two paths that pick assemblies differently would disagree
 * about what "ran" means, and the operator would have no way to tell which one lied.
 */
export async function unityTestForChat(repo: string, csv: string): Promise<string> {
  if (!isUnityProject(repo)) return `${repo} is not a Unity project.`;
  const all = testAssemblies(repo);
  const wanted = csv.split(',').map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) {
    if (!all.length) return 'No test assemblies in this project.';
    return [`${all.length} test assembly(ies) — /unity-test <names, comma-separated>`,
      ...all.map(({ asmdef, state }) => `  ${asmdef.editorOnly ? 'EditMode' : 'PlayMode'}  ${asmdef.name}  ${state}`),
    ].join('\n');
  }
  const picked: Asmdef[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const hit = all.find((a) => a.asmdef.name.toLowerCase() === name.toLowerCase());
    if (hit) picked.push(hit.asmdef); else missing.push(name);
  }
  if (missing.length) {
    return `No test assembly named ${missing.map((m) => `"${m}"`).join(', ')}.\n`
      + `This project has: ${all.map((a) => a.asmdef.name).join(', ') || '(none)'}`;
  }
  const result = await runSelection(repo, {
    domains: [picked.map((a) => a.name).join(', ')], files: [], assemblies: picked, guessed: false,
  });
  return formatReport(result);
}
