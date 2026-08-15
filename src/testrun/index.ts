/**
 * testrun/index.ts — `/testrun <domains>` and `ayin testrun`.
 *
 * Selection is deterministic; only the operator's decision is interactive.
 *
 *   domains → FILES        from the corpus, where a domain is already recorded on every chunk
 *   files   → ASSEMBLIES   nearest-ancestor asmdef, then which test assemblies reference them
 *   assemblies → RUN       prebuilt DLLs when they are current, batch mode when they are not
 *
 * THE DOMAIN STEP IS A LOOKUP, NOT A JUDGEMENT. `indulge` already asked a model which files a domain
 * covers, verified every citation against the repo, and wrote the domains onto each chunk. Asking a
 * model again at test time would be a second, unverified opinion about a question already answered
 * with evidence — and it would drift from what the corpus believes, which is the thing `/diff`-style
 * retrieval is supposed to make consistent.
 *
 * With no corpus, selection falls back to matching the domain words against assembly names and
 * paths. That is weaker, and it SAYS so, because a test run that quietly selected the wrong
 * assemblies and passed is worse than one that admits it guessed.
 */

import { ensureToolRuntime } from '../tool-wiring.js';
import { openStore } from '../indulge/store.js';

// A module that imports `tools/` must wire the runtime itself rather than trusting that something
// else in the process already did — `ayin testrun` is its own entry point and loads no agent loop.
ensureToolRuntime();
import { toolConfirm } from '../tools/runtime.js';
import {
  buildAsmdefIndex, compiledState, isUnityProject, testAssembliesCovering,
  unityHasProjectOpen, type AsmdefIndex, type Asmdef, type CompiledAssembly,
} from './asmdef.js';
import { quitUnity, runAssembly, runBatchmode, findRunner, type AssemblyOutcome } from './run.js';

export interface Selection {
  domains: string[];
  /** Repo-relative files the domains resolved to. */
  files: string[];
  assemblies: Asmdef[];
  /** True when no corpus answered and names were matched instead. */
  guessed: boolean;
}

/** Domain → files, straight out of the corpus. Case- and space-insensitive on the domain name. */
export function filesForDomains(repo: string, domains: string[]): string[] {
  const store = openStore(repo);
  if (!store.exists()) return [];
  const want = domains.map((d) => d.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!want.length) return [];
  const files = new Set<string>();
  for (const c of store.chunks()) {
    const chunkDomains = [...(c.domains ?? []), ...(c.domain ? [c.domain] : [])]
      .map((d) => d.toLowerCase().replace(/\s+/g, ' ').trim());
    // Substring either way: "reward" should reach a corpus that recorded "reward service", and a
    // request for "reward service" should reach one that recorded "reward".
    if (!chunkDomains.some((cd) => want.some((w) => cd.includes(w) || w.includes(cd)))) continue;
    if (c.entity?.file) files.add(c.entity.file);
    for (const f of c.files ?? []) files.add(f);
  }
  return [...files];
}

/** No corpus: match the words against assembly names and directories, and admit it. */
function assembliesByName(index: AsmdefIndex, domains: string[]): Asmdef[] {
  const words = domains.flatMap((d) => d.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length > 2);
  if (!words.length) return [];
  return index.all.filter((a) => {
    if (!a.isTest) return false;
    const hay = `${a.name} ${a.dir}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });
}

export function select(repo: string, domains: string[]): Selection {
  const index = buildAsmdefIndex(repo);
  const files = filesForDomains(repo, domains);
  if (files.length) {
    return { domains, files, assemblies: testAssembliesCovering(index, files), guessed: false };
  }
  return { domains, files: [], assemblies: assembliesByName(index, domains), guessed: true };
}

// ── running ──────────────────────────────────────────────────────────────────────

export interface TestRunResult {
  selection: Selection;
  outcomes: AssemblyOutcome[];
  /** How the run happened, for the report — the reader must know what they are trusting. */
  mode: 'prebuilt' | 'batchmode' | 'none';
  note?: string;
}

/**
 * Run the selected assemblies.
 *
 * The prompt appears whenever the Editor holds the project, because that is the only moment the
 * choice matters. `toolConfirm` returns null with nobody to ask — headless, `watch`, a scheduled
 * run — and null is a refusal: quitting an operator's editor is not a thing to do on a guess.
 */
export async function runSelection(repo: string, selection: Selection): Promise<TestRunResult> {
  if (!selection.assemblies.length) {
    return { selection, outcomes: [], mode: 'none', note: 'no test assemblies matched those domains' };
  }
  const compiled = compiledState(repo, selection.assemblies);
  const stale = compiled.filter((c) => c.stale);
  const missing = compiled.filter((c) => !c.dll);
  const runnable = compiled.filter((c) => c.dll && !c.stale);

  const editorOpen = isUnityProject(repo) && unityHasProjectOpen(repo);
  const needsUnity = stale.length > 0 || missing.length > 0;

  // Everything current and nothing to recompile → just run. No prompt: there is no decision here.
  if (!needsUnity) return prebuilt(selection, runnable);

  const why = [
    stale.length ? `${stale.length} assembly(ies) have sources newer than their compiled DLL` : '',
    missing.length ? `${missing.length} were never compiled` : '',
  ].filter(Boolean).join(' · ');

  if (!editorOpen) {
    // Nothing to quit; batch mode can just go. Still worth confirming — it is minutes, not seconds.
    const choice = await toolConfirm(
      'Recompile with Unity batch mode?',
      [
        { id: 'batch', label: 'Run batch mode', sub: 'authoritative · minutes' },
        { id: 'prebuilt', label: `Run the ${runnable.length} current assembly(ies) only`, sub: 'seconds · partial' },
        { id: 'cancel', label: 'Cancel' },
      ],
      { subtitle: why },
    );
    if (choice === 'batch') return batch(repo, selection, why);
    if (choice === 'prebuilt') return prebuilt(selection, runnable, `${why} — those were skipped`);
    return { selection, outcomes: [], mode: 'none', note: choice === null ? 'nobody to ask (headless) — nothing run' : 'cancelled' };
  }

  const choice = await toolConfirm(
    'Unity has this project open. Batch mode needs it closed.',
    [
      {
        id: 'prebuilt',
        label: `Run the ${runnable.length} already-compiled assembly(ies)`,
        sub: 'seconds · leaves Unity alone · skips anything stale',
      },
      {
        id: 'quit',
        label: 'Quit Unity and run batch mode',
        sub: 'authoritative · you lose the warm Editor and a domain reload on reopen',
        destructive: true,
      },
      { id: 'cancel', label: 'Cancel' },
    ],
    { subtitle: why },
  );

  if (choice === 'quit') {
    const quit = quitUnity(repo);
    if (!quit.ok) return { selection, outcomes: [], mode: 'none', note: quit.reason };
    return batch(repo, selection, why);
  }
  if (choice === 'prebuilt') return prebuilt(selection, runnable, `${why} — those were skipped`);
  return {
    selection, outcomes: [], mode: 'none',
    note: choice === null
      ? 'Unity holds the project and there is nobody to ask — nothing run. Close Unity, or run this interactively.'
      : 'cancelled',
  };
}

function prebuilt(selection: Selection, runnable: CompiledAssembly[], note?: string): TestRunResult {
  if (!findRunner()) {
    return {
      selection, outcomes: [], mode: 'none',
      note: 'no NUnit runner found. Install one (nunit3-console) or point ayin at yours: /set nunit-console <path>',
    };
  }
  const outcomes = runnable.map((c) => runAssembly(c.dll as string, c.asmdef.name));
  return { selection, outcomes, mode: 'prebuilt', note };
}

function batch(repo: string, selection: Selection, note?: string): TestRunResult {
  const names = selection.assemblies.map((a) => a.name);
  const editMode = selection.assemblies.filter((a) => a.editorOnly).map((a) => a.name);
  const playMode = names.filter((n) => !editMode.includes(n));
  const outcomes: AssemblyOutcome[] = [];
  let error: string | undefined;
  for (const [platform, list] of [['EditMode', editMode], ['PlayMode', playMode]] as const) {
    if (!list.length) continue;
    const r = runBatchmode(repo, list, platform);
    if (r.error) { error = r.error; break; }
    outcomes.push(...r.outcomes);
  }
  return { selection, outcomes, mode: 'batchmode', note: error ?? note };
}

// ── the report ───────────────────────────────────────────────────────────────────

/**
 * What actually happened, in the order the reader needs it.
 *
 * `not run` is a FIRST-CLASS LINE, never folded into the totals. A green summary over an assembly
 * that failed to load is the one output worth refusing to produce — it is the same rule the corpus
 * follows about unproven chunks, and `/diff` about hidden files.
 */
export function formatReport(r: TestRunResult): string {
  const out: string[] = [];
  const total = (k: 'passed' | 'failed' | 'skipped'): number => r.outcomes.reduce((n, o) => n + o[k], 0);
  const notRun = r.outcomes.filter((o) => o.notRun);

  out.push(`${r.selection.domains.join(', ')} → ${r.selection.assemblies.length} test assembly(ies)`
    + (r.selection.guessed ? '  [matched by NAME — no corpus for these domains, so this is a guess]' : ''));
  if (r.mode === 'none') {
    out.push(r.note ?? 'nothing run');
    return out.join('\n');
  }
  out.push(`ran via ${r.mode === 'prebuilt' ? 'Library/ScriptAssemblies (already compiled)' : 'Unity batch mode'}`);
  if (r.note) out.push(r.note);
  out.push('');

  for (const o of r.outcomes) {
    if (o.notRun) { out.push(`  ✗ ${o.assembly} — NOT RUN: ${o.notRun}`); continue; }
    const mark = o.failed ? '✗' : '✓';
    out.push(`  ${mark} ${o.assembly}  ${o.passed} passed · ${o.failed} failed · ${o.skipped} skipped`);
    for (const c of o.cases.filter((x) => x.outcome === 'failed')) {
      out.push(`      ${c.name}`);
      if (c.message) for (const line of c.message.split('\n').slice(0, 4)) out.push(`        ${line}`);
    }
  }

  out.push('');
  out.push(`${total('passed')} passed · ${total('failed')} failed · ${total('skipped')} skipped`
    + (notRun.length ? ` · ${notRun.length} assembly(ies) NOT RUN` : ''));
  if (notRun.length) out.push('A not-run assembly is not a pass — the summary above excludes it deliberately.');
  return out.join('\n');
}

const USAGE = `ayin testrun <domains> — run the C# tests covering a domain.

  ayin testrun "reward service"
  ayin testrun "reward service,solitaire streak"
  --list        show what would run, run nothing

Selection comes from the indulge corpus: a domain's chunks name files, files belong to assemblies,
and a test assembly that references one of them covers it. With no corpus, names are matched and the
report says it guessed.

Runs against Library/ScriptAssemblies when those are current; offers Unity batch mode when they are
not. Never runs a stale assembly silently.
`;

export async function runTestrunCli(argv: string[]): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return argv.length ? 0 : 1;
  }
  const repo = process.cwd();
  const domains = argv.filter((a) => !a.startsWith('-')).join(' ').split(',').map((s) => s.trim()).filter(Boolean);
  const selection = select(repo, domains);
  if (argv.includes('--list')) {
    process.stdout.write(
      `${domains.join(', ')} → ${selection.files.length} file(s) → ${selection.assemblies.length} test assembly(ies)`
      + `${selection.guessed ? ' [guessed by name]' : ''}\n`
      + selection.assemblies.map((a) => `  ${a.name}  ${a.editorOnly ? 'EditMode' : 'PlayMode'}\n`).join(''),
    );
    return 0;
  }
  const result = await runSelection(repo, selection);
  process.stdout.write(`${formatReport(result)}\n`);
  return result.outcomes.some((o) => o.failed > 0 || o.notRun) ? 1 : 0;
}
