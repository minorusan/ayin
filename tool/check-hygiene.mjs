/**
 * check-hygiene.mjs — this repository is public, and a clone cannot be un-read.
 *
 * The rule has been written down for months and enforced by a human remembering it. A human remembering
 * is not a control: an employer's org name reached the public history inside a comment explaining an SSH
 * alias, and stayed there for twenty-one commits before anyone looked. Twice in one day a private
 * identifier had to be stripped after it was already pushed.
 *
 * So it runs on every build.
 *
 * WHAT IT CANNOT DO IS NAME THE SECRETS. A gate that hardcodes "the employer is called X" leaks X to
 * everyone who clones — the check would become the disclosure. Universal shapes live here (private
 * address ranges, home directories, an SSH config alias); everything site-specific comes from a file
 * OUTSIDE the repository, `~/.ayin-cli/hygiene-terms.txt`, one term per line. No file, no site terms,
 * and the universal half still runs.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const REPO = new URL('..', import.meta.url).pathname;
const ROOTS = ['src', 'tool', 'prompts', 'help', 'docs', 'assets'];
const SKIP_FILES = new Set(['CLAUDE.local.md']);

const failures = [];
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };

/** Shapes that are private wherever they appear, and safe to name in a public file. */
const UNIVERSAL = [
  [/\b(?:192\.168\.\d{1,3}|10\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\b/, 'a private LAN address'],
  [/\/home\/(?!you\/|user\/|name\/|me\/|someone\/)[a-z][a-z0-9_-]{2,}\//, 'an absolute Linux home directory'],
  [/\/Users\/(?!you\/|user\/|name\/|me\/|someone\/)[a-z][a-z0-9_-]{2,}\//, 'an absolute macOS home directory'],
  [/\bssh:\/\/[a-z0-9_-]+@[\w.-]+/, 'an SSH URL with a user in it'],
];

/**
 * `/Users/you/…` is a PLACEHOLDER, and a gate that cannot tell it from `/Users/<a real person>/`
 * teaches the writer to delete the example that made the sentence clear. The negative lookaheads
 * above are the whole difference between a rule people follow and a rule people route around.
 */

/**
 * A file git already ignores never leaves this machine, so it is out of scope — and it is exactly
 * where the local notes live (docs/HANDOFF.md names paths and hosts ON PURPOSE, which is why it is
 * gitignored). Flagging it would train the operator to ignore this gate's output, which costs more
 * than it protects.
 */
function ignoredByGit(paths) {
  if (!paths.length) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: REPO, input: paths.join('\n'), encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch { return new Set(); } // exit 1 simply means "none of them are ignored"
}

const siteTermsPath = join(homedir(), '.ayin-cli', 'hygiene-terms.txt');
const siteTerms = existsSync(siteTermsPath)
  ? readFileSync(siteTermsPath, 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : [];

function* files(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { yield* files(p); continue; }
    if (SKIP_FILES.has(e)) continue;
    if (/\.(ts|mjs|js|md|txt|json|puml|html)$/.test(e)) yield p;
  }
}

const all = [];
for (const root of ROOTS) for (const path of files(join(REPO, root))) all.push(path.slice(REPO.length));
const ignored = ignoredByGit(all);

let scanned = 0;
let skipped = 0;
for (const root of ROOTS) {
  for (const path of files(join(REPO, root))) {
    if (ignored.has(path.slice(REPO.length))) { skipped++; continue; }
    scanned++;
    let body;
    try { body = readFileSync(path, 'utf-8'); } catch { continue; }
    const rel = path.slice(REPO.length);

    for (const [re, what] of UNIVERSAL) {
      const m = body.match(re);
      // The finding NAMES the match, which is safe: it is printed on the operator's own terminal
      // during their own build, never committed.
      if (m) fail(`${rel} contains ${what}: "${m[0]}"`);
    }
    for (const term of siteTerms) {
      if (body.includes(term)) fail(`${rel} contains a site term from ~/.ayin-cli/hygiene-terms.txt`);
    }
  }
}

ok(`${scanned} files scanned across ${ROOTS.join(', ')}${skipped ? ` · ${skipped} gitignored, out of scope` : ''}`);
ok(siteTerms.length
  ? `${siteTerms.length} site-specific term(s) loaded from ~/.ayin-cli/hygiene-terms.txt`
  : 'no ~/.ayin-cli/hygiene-terms.txt — universal shapes only. Put your employer, host and project names there, one per line.');
if (!failures.length) ok('nothing private in anything that ships');

console.log(failures.length ? `\nhygiene check: ${failures.length} FAILED — do NOT push` : '\nhygiene check: ok');
process.exit(failures.length ? 1 : 0);
