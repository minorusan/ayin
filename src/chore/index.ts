/**
 * chore/index.ts — what was ADDED recently and is used by nothing.
 *
 * THE QUESTION THIS ANSWERS. A dead-code scan over a whole repository returns hundreds of items, most of
 * them public API, test helpers or Unity-serialized fields, and nobody reads the list twice. The useful
 * question is narrower and has an owner: *of the members added in the last N commits, which are used by
 * nothing?* That set is small, every item is fresh enough that whoever wrote it still remembers why, and
 * the commit that introduced it is part of the report — so an item is a decision, not an archaeology
 * assignment.
 *
 * THREE STEPS, ALL DETERMINISTIC. No model touches this.
 *
 *   1. `git log -n N --name-only` gives the files those commits touched.
 *   2. For each commit, the ADDED lines in those files, filtered to lines that DECLARE a member — a
 *      method, property or field. The patterns are per-language and deliberately narrow: one that also
 *      matched calls would report every added call site as dead code, which teaches the reader to
 *      distrust the whole report.
 *   3. Every candidate is RE-CHECKED AGAINST HEAD, which is what makes the report trustworthy. A member
 *      added in commit 7 and deleted in commit 9 is not dead code, it is history — if its declaration is
 *      gone from the final state, it is dropped. What survives is searched across the branch as it stands
 *      now, not as it stood when the commit landed.
 *
 * WHY "UNUSED" IS NOT "DEAD", AND SAYS SO. In a Unity project a `[SerializeField]` private field is
 * written by the Editor and read by nobody in C#; a method named in an `.anim` clip is called by the
 * animation system; an `override` is called through its base type; an NUnit `[Test]` is invoked by
 * reflection. None of that is visible to a name search of source files. So the search covers assets and
 * data files too, every finding carries the reasons it might still be alive, and confidence is stated
 * rather than implied.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { log } from '../log.js';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Commits looked back over. Ten is "this week's work" on an active branch. */
export const DEFAULT_COMMITS = 10;

/** Files whose additions are examined. Anything else is data, generated, or not code. */
const CODE_EXT = new Set(['.cs', '.ts', '.tsx', '.js', '.jsx', '.mjs']);

/** Where a name can be referenced from without being code — Unity's own wiring, and config. */
const ASSET_GLOBS = ['*.prefab', '*.unity', '*.asset', '*.anim', '*.controller', '*.playable', '*.json', '*.uxml'];

const CODE_GLOBS = ['*.cs', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs'];

/** Directories that hold no authored source and would swamp a search. */
const PRUNE = [
  '.git', 'node_modules', 'Library', 'Temp', 'obj', 'Logs', 'Build', 'Builds', 'dist', 'build', 'out',
  'coverage', '.venv', '__pycache__',
];

export type MemberKind = 'method' | 'property' | 'field';

export interface CommitRef { sha: string; date: string; subject: string; author: string }

export interface Candidate {
  name: string;
  kind: MemberKind;
  /** Repo-relative file the declaration is in, as of HEAD. */
  file: string;
  /** Line in HEAD, 1-based. 0 while unresolved. */
  line: number;
  /** The declaration as written, trimmed. */
  declaration: string;
  /** The commit that introduced it — the half that makes an item actionable. */
  commit: CommitRef;
  /** What the declaration says about itself that changes whether "unused" means anything. */
  notes: string[];
}

export interface Reference { file: string; count: number }

export interface Finding extends Candidate {
  /** References from CODE, excluding the declaration itself. */
  usedIn: Reference[];
  uses: number;
  /** References from assets and data files — Unity wiring rather than a call. */
  assetRefs: Reference[];
  confidence: 'likely' | 'possible' | 'unlikely';
  /** Why it might still be alive despite no references. */
  caveats: string[];
}

export interface ChoreReport {
  repo: string;
  branch: string;
  commits: CommitRef[];
  /** Code files those commits touched. */
  filesExamined: number;
  candidates: number;
  findings: Finding[];
  generatedAt: string;
  /** Stated rather than implied — a scan that could not look somewhere must say so. */
  skipped: string[];
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function gitQuiet(repo: string, args: string[]): string {
  try { return git(repo, args).trim(); } catch { return ''; }
}

export function isGitRepo(repo: string): boolean {
  return existsSync(join(repo, '.git')) || gitQuiet(repo, ['rev-parse', '--git-dir']) !== '';
}

// ── step 1: the commits, and what they touched ───────────────────────────────────

interface CommitInfo extends CommitRef { files: string[] }

/**
 * Record and Unit separators between commits and fields, because a commit subject can contain anything
 * printable — including any punctuation a person might reach for as a delimiter.
 *
 * NOT NUL, which was the first choice and is unusable: an argv string is a C string, so a `\x00` inside
 * `--pretty=format:` truncates the argument to nothing. git then printed no headers at all, the parse
 * found no commits, and the report said "0 commits" on a repository with thousands.
 */
const REC = '\x1e';
const FLD = '\x1f';

function recentCommits(repo: string, count: number): CommitInfo[] {
  const raw = gitQuiet(repo, [
    'log', `-n${count}`, '--no-merges', '--name-only', '--date=short',
    `--pretty=format:${REC}%h${FLD}%ad${FLD}%an${FLD}%s`,
  ]);
  if (!raw) return [];
  const out: CommitInfo[] = [];
  for (const block of raw.split(REC)) {
    if (!block.trim()) continue;
    const [header, ...rest] = block.split('\n');
    const [sha, date, author, subject] = header.split(FLD);
    if (!sha) continue;
    out.push({
      sha, date: date ?? '', author: author ?? '', subject: subject ?? '',
      files: rest.map((l) => l.trim()).filter(Boolean),
    });
  }
  return out;
}

// ── step 2: what those commits ADDED that declares a member ─────────────────────

/**
 * Declaration patterns, matched against a single ADDED line.
 *
 * Narrow on purpose. `(\w+)\s*\(` matches every call site, and a report that lists added calls as dead
 * code is worse than none. So a C# method needs a return type before its name, and a field needs an
 * access modifier and a terminating semicolon.
 */
const CS_PROPERTY = /^\s*(?:\[[^\]]*\]\s*)*(?:public|private|protected|internal)\s+(?:static\s+|virtual\s+|override\s+|sealed\s+|new\s+|abstract\s+)*[A-Za-z_][\w<>,.\[\]?]*\s+([A-Za-z_]\w*)\s*(?:\{\s*(?:get|set)|=>)/;
const CS_METHOD = /^\s*(?:\[[^\]]*\]\s*)*(?:public|private|protected|internal)?\s*(?:static\s+|virtual\s+|override\s+|sealed\s+|async\s+|extern\s+|unsafe\s+|new\s+|partial\s+|abstract\s+)*([A-Za-z_][\w<>,.\[\]?]*)\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=>|$)/;
const CS_FIELD = /^\s*(?:\[[^\]]*\]\s*)*(?:public|private|protected|internal)\s+(?:static\s+|readonly\s+|const\s+|volatile\s+)*[A-Za-z_][\w<>,.\[\]?]*\s+([A-Za-z_]\w*)\s*(?:=[^;]*)?;/;

const TS_PROPERTY = /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+)*(?:get|set)\s+([A-Za-z_]\w*)\s*\(/;
const TS_METHOD = /^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:function\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^{;]+)?\s*\{\s*$/;
const TS_FIELD = /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+)+([A-Za-z_]\w*)\s*[:=][^=]/;

/** Words that are never a member name worth reporting. */
const NOT_A_MEMBER = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'using', 'return', 'lock', 'foreach', 'do', 'else', 'try',
  'get', 'set', 'new', 'class', 'struct', 'interface', 'enum', 'namespace', 'record', 'function',
  'const', 'let', 'var', 'export', 'import', 'await', 'typeof', 'yield', 'constructor',
]);

/** C# primitive and common return types — their presence is what separates a declaration from a call. */
const CS_TYPEISH = /^(?:void|int|uint|long|ulong|short|byte|sbyte|float|double|decimal|bool|char|string|object|var|dynamic|Task|Task<|IEnumerator|IEnumerable|List<|Dictionary<|[A-Z]\w*)/;

interface Declared { name: string; kind: MemberKind }

function declaredBy(line: string, ext: string): Declared | null {
  if (ext === '.cs') {
    const prop = CS_PROPERTY.exec(line);
    if (prop && !NOT_A_MEMBER.has(prop[1])) return { name: prop[1], kind: 'property' };
    const method = CS_METHOD.exec(line);
    if (method) {
      const [, type, name] = method;
      // A constructor has no return type, so the "type" slot holds the class name and the two match.
      // `new Foo(...)` is a call, not a declaration, and both would otherwise land here.
      if (!NOT_A_MEMBER.has(name) && type !== name && CS_TYPEISH.test(type)) {
        return { name, kind: 'method' };
      }
    }
    const field = CS_FIELD.exec(line);
    if (field && !NOT_A_MEMBER.has(field[1])) return { name: field[1], kind: 'field' };
    return null;
  }
  const prop = TS_PROPERTY.exec(line);
  if (prop && !NOT_A_MEMBER.has(prop[1])) return { name: prop[1], kind: 'property' };
  const method = TS_METHOD.exec(line);
  if (method && !NOT_A_MEMBER.has(method[1])) return { name: method[1], kind: 'method' };
  const field = TS_FIELD.exec(line);
  if (field && !NOT_A_MEMBER.has(field[1])) return { name: field[1], kind: 'field' };
  return null;
}

/**
 * What the declaration says about why "unused" may not mean dead.
 *
 * `text` is the declaration WITH the attribute lines above it, because that is where C# puts them.
 */
function notesFor(line: string, ext: string): string[] {
  const notes: string[] = [];
  if (/\[SerializeField\]/.test(line)) notes.push('[SerializeField] — the Unity Editor writes this, not C#');
  if (/\[SerializeReference\]/.test(line)) notes.push('[SerializeReference] — assigned in an asset');
  if (/\boverride\b/.test(line)) notes.push('override — called through its base type');
  if (/\bvirtual\b|\babstract\b/.test(line)) notes.push('virtual/abstract — called through a subclass');
  if (/\[(?:Test|TestCase|UnityTest|SetUp|TearDown|OneTimeSetUp|OneTimeTearDown)\]/.test(line)) {
    notes.push('a test entry point — NUnit invokes it by reflection');
  }
  if (/\[(?:UnityEngine\.)?(?:RuntimeInitializeOnLoadMethod|MenuItem|ContextMenu|InitializeOnLoadMethod|Button|Inject)\]/.test(line)) {
    notes.push('attribute-invoked — the engine or container calls it, nothing names it');
  }
  // Multiline: `line` is the declaration WITH its attributes and doc comment, so an unanchored `^` would
  // test the comment rather than the declaration — which silently dropped this note on every documented
  // member, the first one measured being an exported function that really was unused.
  if (/^\s*(?:\[[^\]]*\]\s*)*public\b/m.test(line) || /^\s*export\b/m.test(line)) {
    notes.push('public — may be used outside this repository');
  }
  if (ext === '.cs' && /\bpartial\b/.test(line)) notes.push('partial — the other half may use it');
  return notes;
}

/**
 * A member nothing NAMES because something CALLS it by reflection — a test, a menu item, an engine hook,
 * a serialized field, a DI target.
 *
 * These are excluded from the report by default and counted instead. They are never actionable: an NUnit
 * `[Test]` has no callers by design, and a report whose top four items are tests is a report that gets
 * ignored. `--all` brings them back for anyone auditing the scan itself.
 */
const INVOKED_ELSEWHERE = /\[(?:Test|TestCase|TestCaseSource|UnityTest|SetUp|TearDown|OneTimeSetUp|OneTimeTearDown|Theory|Values|ValueSource)|\[(?:UnityEngine\.)?(?:RuntimeInitializeOnLoadMethod|MenuItem|ContextMenu|InitializeOnLoadMethod|Button|Inject|SerializeField|SerializeReference|Preserve|DllImport|ContextMenuItem)/;

function invokedElsewhere(context: string): boolean {
  return INVOKED_ELSEWHERE.test(context);
}

/**
 * Candidates from one commit: added lines that declare a member.
 *
 * `git show` per commit rather than one range diff, because the COMMIT is part of the report and an item
 * whose origin is "somewhere in the range you asked for" cannot be acted on. `--unified=0` keeps context
 * lines out — a context line is code that was already there.
 */
function candidatesFrom(repo: string, commit: CommitInfo): Candidate[] {
  const out: Candidate[] = [];
  const codeFiles = commit.files.filter((f) => CODE_EXT.has(extname(f).toLowerCase()));
  if (!codeFiles.length) return out;

  const diff = gitQuiet(repo, ['show', commit.sha, '--unified=0', '--no-color', '--', ...codeFiles]);
  if (!diff) return out;

  let file = '';
  for (const line of diff.split('\n')) {
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus) { file = plus[1]; continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (!file || !CODE_EXT.has(extname(file).toLowerCase())) continue;
    const text = line.slice(1);
    const ext = extname(file).toLowerCase();
    const decl = declaredBy(text, ext);
    if (!decl) continue;
    out.push({
      ...decl, file, line: 0, declaration: text.trim(),
      commit: { sha: commit.sha, date: commit.date, subject: commit.subject, author: commit.author },
      notes: notesFor(text, ext),
    });
  }
  return out;
}

// ── step 3: re-check against HEAD, then search the branch as it stands ──────────

/** How far back to look for the attributes that belong to a declaration. */
const ATTRIBUTE_LOOKBACK = 4;

/**
 * Where the declaration sits in HEAD now — the re-check — together with the lines above it.
 *
 * THE CONTEXT IS NOT OPTIONAL. In C# an attribute goes on its OWN line, so a `[Test]` method looks like
 * an ordinary public void to anything reading one line at a time: the first run of this over a real
 * project reported four NUnit tests as dead code, which is exactly the kind of false positive that gets a
 * report ignored. Read from HEAD rather than from the diff, because that is the state being judged.
 */
function declarationInHead(
  repo: string, file: string, name: string, kind: MemberKind,
): { line: number; context: string } {
  const abs = join(repo, file);
  if (!existsSync(abs)) return { line: 0, context: '' };
  let text: string;
  try { text = readFileSync(abs, 'utf-8'); } catch { return { line: 0, context: '' }; }
  const ext = extname(file).toLowerCase();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const d = declaredBy(lines[i], ext);
    if (!d || d.name !== name || d.kind !== kind) continue;
    const above: string[] = [];
    for (let j = i - 1; j >= 0 && j >= i - ATTRIBUTE_LOOKBACK; j--) {
      const t = lines[j].trim();
      if (!t) continue;
      // Only the decoration that belongs to this member: attributes, and the doc comment above them.
      if (/^\[/.test(t) || /^\/\//.test(t) || /^\*/.test(t) || /^\/\*/.test(t)) { above.unshift(lines[j]); continue; }
      break;
    }
    return { line: i + 1, context: [...above, lines[i]].join('\n') };
  }
  return { line: 0, context: '' };
}

/** Names per grep. The pattern is one alternation; a few hundred names is a short command line. */
const NAME_CHUNK = 150;

/** A reference: which name, in which file, on which line. */
interface Hit { name: string; file: string; line: number }

/**
 * EVERY candidate's references in ONE pass, rather than one pass per candidate.
 *
 * Measured before this: 69 candidates × 2 searches × a full Unity tree = 204 SECONDS for one report,
 * which is a tool nobody waits for. `grep -rnow -E 'a|b|c'` prints `file:line:match`, so a single walk
 * attributes every hit to the name that produced it — the same trick the guid resolver uses, for the same
 * reason. Chunked so the command line stays sane on a large report.
 */
function findReferences(repo: string, names: string[], includes: string[]): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < names.length; i += NAME_CHUNK) {
    const chunk = names.slice(i, i + NAME_CHUNK);
    /**
     * `git grep` when this is a work tree, which it always is — chore reads history to exist.
     *
     * It walks the index rather than the filesystem, it is parallel, and it skips ignored paths for free:
     * on a Unity project that means `Library/` (gigabytes of package cache and compiled assemblies) costs
     * nothing instead of dominating the scan. Measured on one real project: 96s of plain grep for one
     * report. `--untracked` is included because a file the operator has not committed is still code that
     * can reference a member.
     */
    let out = '';
    try {
      out = execFileSync('git', [
        'grep', '--no-color', '-nowI', '--untracked', '-E', chunk.join('|'),
        '--', ...includes,
      ], { cwd: repo, encoding: 'utf-8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      // Exit 1 is "no match" and exit 128 is "not a work tree". Only the second is worth a fallback, and
      // telling them apart costs more than simply trying the portable path when nothing came back.
      try {
        out = execFileSync('grep', [
          '-rnowI', ...PRUNE.map((d) => `--exclude-dir=${d}`),
          ...includes.map((g) => `--include=${g}`), '-E', chunk.join('|'), '.',
        ], { cwd: repo, encoding: 'utf-8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { continue; }
    }
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const m = /^(.+?):(\d+):(\w+)$/.exec(line);
      if (!m) continue;
      hits.push({ name: m[3], file: m[1].replace(/^\.\//, ''), line: Number(m[2]) });
    }
  }
  return hits;
}

/** Group hits for one name into per-file counts, dropping the declaration's own line. */
function referencesFor(hits: Hit[], name: string, declFile: string, declLine: number): Reference[] {
  const byFile = new Map<string, number>();
  for (const h of hits) {
    if (h.name !== name) continue;
    // The declaration is not a use of itself — matched by LINE, not by "subtract one from this file",
    // which was wrong the moment a member was used in the file that declares it.
    if (h.file === declFile && h.line === declLine) continue;
    byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
  }
  return [...byFile.entries()].map(([file, count]) => ({ file, count }));
}

export interface ChoreOptions {
  repo: string;
  commits?: number;
  /** Keep the items that ARE used, so the scan's own work is visible. */
  includeUsed?: boolean;
}

export function runChore(opts: ChoreOptions): ChoreReport {
  const repo = opts.repo;
  const count = Math.max(1, Math.min(100, opts.commits ?? DEFAULT_COMMITS));
  const generatedAt = new Date().toISOString();

  if (!isGitRepo(repo)) {
    return {
      repo, branch: '', commits: [], filesExamined: 0, candidates: 0, findings: [], generatedAt,
      skipped: ['not a git repository — there is no history to read'],
    };
  }

  const branch = gitQuiet(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
  const commits = recentCommits(repo, count);
  const examined = new Set<string>();
  const raw: Candidate[] = [];
  for (const c of commits) {
    for (const f of c.files) if (CODE_EXT.has(extname(f).toLowerCase())) examined.add(f);
    raw.push(...candidatesFrom(repo, c));
  }

  // One entry per member. The NEWEST commit that added it wins, because that is where it comes from now.
  const byKey = new Map<string, Candidate>();
  for (const c of raw) {
    const key = `${c.file}::${c.kind}::${c.name}`;
    if (!byKey.has(key)) byKey.set(key, c);
  }

  // THE RE-CHECK, before any searching: a member added in one commit and deleted in a later one is
  // history rather than dead code, and searching for it would waste the pass and report a ghost.
  const alive: Candidate[] = [];
  let removedSince = 0;
  let invoked = 0;
  for (const cand of byKey.values()) {
    const { line, context } = declarationInHead(repo, cand.file, cand.name, cand.kind);
    if (line === 0) { removedSince++; continue; }
    const notes = notesFor(context, extname(cand.file).toLowerCase());
    if (/(?:^|\/)(?:Tests?|Editor)\//.test(cand.file) || /Tests?\.[cm]?[jt]?s$|Tests?\.cs$/.test(cand.file)) {
      notes.push('in a test or editor path');
    }
    if (!opts.includeUsed && invokedElsewhere(context)) { invoked++; continue; }
    alive.push({ ...cand, line, notes });
  }

  const names = [...new Set(alive.map((c) => c.name))];
  const codeHits = names.length ? findReferences(repo, names, CODE_GLOBS) : [];
  const assetHits = names.length ? findReferences(repo, names, ASSET_GLOBS) : [];

  const findings: Finding[] = [];
  for (const cand of alive) {
    const inCode = referencesFor(codeHits, cand.name, cand.file, cand.line);
    const inAssets = referencesFor(assetHits, cand.name, cand.file, cand.line);
    const uses = inCode.reduce((n, h) => n + h.count, 0);
    if (!opts.includeUsed && (uses > 0 || inAssets.length > 0)) continue;

    const caveats = [...cand.notes];
    if (inAssets.length) {
      caveats.push(`named in ${inAssets.length} asset/data file(s) — engine or config wiring, not a call`);
    }
    const confidence: Finding['confidence'] = uses > 0 || inAssets.length
      ? 'unlikely'
      : caveats.length ? 'possible' : 'likely';

    findings.push({ ...cand, usedIn: inCode, uses, assetRefs: inAssets, confidence, caveats });
  }

  // Most confident first, then newest: the top of the list should be the easiest decision.
  const rank: Record<Finding['confidence'], number> = { likely: 0, possible: 1, unlikely: 2 };
  findings.sort((a, b) => rank[a.confidence] - rank[b.confidence]
    || b.commit.date.localeCompare(a.commit.date));

  log('INFO', 'chore_scanned', {
    repo, commits: String(commits.length), files: String(examined.size),
    candidates: String(byKey.size), findings: String(findings.length),
  });

  const skipped: string[] = [];
  if (commits.length < count) skipped.push(`only ${commits.length} commit(s) of history available`);
  if (removedSince) skipped.push(`${removedSince} member(s) were added and then removed again — history, not dead code`);
  if (invoked) {
    skipped.push(`${invoked} member(s) excluded as invoked by reflection (tests, menu items, engine hooks, `
      + `[SerializeField], DI) — they have no callers by design; pass all=true to see them`);
  }
  return {
    repo, branch, commits, filesExamined: examined.size, candidates: byKey.size,
    findings, generatedAt, skipped,
  };
}

/** Declarations are recognised in these extensions only — stated so coverage is never implied. */
export function choreLanguages(): string[] {
  return [...CODE_EXT];
}
