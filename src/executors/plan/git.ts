/**
 * git.ts — a new project is a repository, and its first commit contains its first files.
 *
 * WHY IT LIVES HERE AND NOT IN `greenfield/`. It was greenfield's, so only python, node and unity got
 * it; a project of any other type — the ones `base` serves — was scaffolded into a plain directory. The
 * base executor cannot import greenfield (greenfield imports base), so the shared thing moves to a
 * module both can reach. That is the whole reason for this file.
 *
 * WHY COMMIT AT ALL. `git init` alone leaves everything the scaffold just wrote as untracked work with
 * no baseline: the operator's first `git diff` after the agent runs mixes the scaffold in with the
 * agent's changes, and there is nothing to revert TO. A commit at project start makes the deterministic
 * half of the work a known point — everything after it is the model's, visible as a diff, revertible on
 * its own.
 *
 * THE GUARDS ARE THE IMPORTANT PART, because this runs unattended and `git` is not undoable by a tool:
 *
 *   · only where `.git` is the directory's OWN repository, never an enclosing one — otherwise
 *     scaffolding inside a checkout would commit that checkout's staged work under our message;
 *   · only when the repository has NO commits at all. A repo with history is somebody's, and its index
 *     may hold work they staged deliberately;
 *   · `git add -A` is scoped to the project directory by `cwd`, and only reached after the two checks
 *     above have established that the directory is a fresh repo of our own making;
 *   · every failure is logged and swallowed. git may be missing, the disk may be read-only, and there
 *     may be no identity configured — none of which is a reason to lose the plan.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../log.js';
import { projectRoot } from '../../qa/probes.js';

/**
 * The QA fact: is this project a repository, and does it have a baseline commit?
 *
 * Asked because the scaffold now promises one, and a promise nothing checks is a promise that quietly
 * stops being kept — `git init` succeeding while the commit silently failed (no identity configured, a
 * read-only `.git`) looks identical from the outside to everything working.
 *
 * HARD ONLY ON A GREENFIELD TURN. On a project we just created, no commit means the scaffold did not
 * finish and the operator has no baseline to diff the agent's work against — a measured, binary defect,
 * which is what `hard` is for. On somebody's existing project it is reported and left to the judge:
 * plenty of real work happens in directories that are not repositories, and failing a turn over that
 * would be this gate inventing a requirement nobody asked for.
 */
export function repoBaselineFact(ctx: { root: string; greenfield?: boolean }): {
  key: string; ok: boolean; detail: string; hard?: boolean;
} {
  const state = repoState(ctx.root);
  if (!state.repo) {
    return {
      key: 'git-baseline',
      ok: true,
      detail: 'not a git repository — nothing to check. Not every project is versioned.',
    };
  }
  if (!state.own) {
    return {
      key: 'git-baseline',
      ok: true,
      detail: 'inside an enclosing repository — its history is not this project\'s to judge.',
    };
  }
  if (state.commits === 0) {
    return {
      key: 'git-baseline',
      ok: false,
      hard: !!ctx.greenfield,
      detail: 'the repository has NO commits. The scaffold initialises one and commits what it wrote, '
        + 'so an empty history means that commit failed — there is no baseline to diff this work against.',
    };
  }
  return {
    key: 'git-baseline',
    ok: true,
    detail: `git: ${state.commits} commit(s), HEAD ${state.head} — the work has a baseline to diff against.`,
  };
}

/**
 * Nothing here but a repository, if that — the condition for `base` to initialise one.
 *
 * `ctx.greenfield` is not enough on its own: it requires the REQUEST to have named a known project
 * type, so *"make me a brand new haskell thing here"* in an empty folder detects as `unknown`, is
 * served by `base`, and used to get no repository at all. Emptiness is the honest question for the
 * generic case — an empty directory becoming a project should become a repository, whatever the
 * project turns out to be.
 *
 * And it is the SAFE question. `base` is also selected for every established project of an unclaimed
 * type, where `git init` over somebody's unversioned working directory — and a commit of all of it
 * under our message — would be the most intrusive thing in this file's reach. A directory with files
 * in it is somebody's; a directory with nothing in it is not yet anybody's.
 */
export function isEmptyProjectDir(root: string): boolean {
  try {
    return readdirSync(root).filter((e) => e !== '.git').length === 0;
  } catch {
    return false;
  }
}

/** Run git in `dir`, returning trimmed stdout, or null when it failed for any reason. */
function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: dir, timeout: 15_000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Does this directory have a repository of its OWN (not an enclosing one), and does it have history? */
export function repoState(dir: string): { repo: boolean; own: boolean; commits: number; head: string } {
  const own = existsSync(join(dir, '.git')) && projectRoot(dir) === dir;
  if (!own) return { repo: existsSync(join(dir, '.git')), own: false, commits: 0, head: '' };
  const count = git(dir, ['rev-list', '--count', 'HEAD']);
  const head = git(dir, ['rev-parse', '--short', 'HEAD']) ?? '';
  return { repo: true, own: true, commits: Number(count ?? 0) || 0, head };
}

/**
 * `git init`, once, at project start.
 *
 * `projectRoot()` answers `git rev-parse --show-toplevel`, so asking it about the directory we are
 * about to use is what refuses to nest a repository inside one that already exists — whether that
 * directory is the enclosing repo's root or a new folder made inside it.
 */
export function ensureGitRepo(root: string): string[] {
  const dotGit = join(root, '.git');
  if (existsSync(dotGit)) return [];
  const enclosing = projectRoot(root);
  if (enclosing !== root) {
    log('INFO', 'scaffold_git_init_skipped', { root, enclosing });
    return [];
  }
  if (git(root, ['init']) === null) {
    log('WARN', 'scaffold_git_init_failed', { root });
    return [];
  }
  log('INFO', 'scaffold_git_init', { root });
  return [dotGit];
}

/**
 * The scaffold's own first commit — only into a repository we just created that has no history.
 *
 * An identity is supplied ONLY when the machine has none configured: a commit that fails because
 * nobody ran `git config --global user.email` is a worse outcome than one attributed to the tool that
 * made it, and this is a brand-new repository either way. Where the operator HAS an identity, theirs is
 * used, because the commit really is being made on their behalf.
 */
export function commitScaffold(root: string, what: string): string[] {
  const state = repoState(root);
  if (!state.own) return [];
  if (state.commits > 0) {
    log('INFO', 'scaffold_commit_skipped', { root, reason: 'the repository already has history', commits: String(state.commits) });
    return [];
  }
  if (git(root, ['add', '-A']) === null) {
    log('WARN', 'scaffold_commit_failed', { root, at: 'add' });
    return [];
  }
  // NOTE ON THE RETURN TYPE: `scaffold()` returns PATHS, and a commit is not one. Everything below
  // reports through the log and through `repoState`, which is what the plan card and the QA fact read
  // — a human-readable "initial commit abc1234" mixed into a path list is a lie to anything that
  // treats the list as paths, and `check-plan.mjs` asserts that every entry exists on disk.
  // Nothing staged means nothing was written — a commit here would fail and say something confusing.
  const staged = git(root, ['diff', '--cached', '--name-only']);
  if (!staged) {
    log('INFO', 'scaffold_commit_skipped', { root, reason: 'nothing staged' });
    return [];
  }
  const hasIdentity = !!git(root, ['config', 'user.email']);
  const identity = hasIdentity
    ? []
    : ['-c', 'user.name=ayin', '-c', 'user.email=ayin@localhost'];
  const message = `chore: scaffold a ${what} project\n\n`
    + 'Written deterministically by ayin before planning started — the manifest, the layout and the\n'
    + 'test wiring, with no model involved. Everything after this commit is the work you asked for.\n';
  if (git(root, [...identity, 'commit', '-q', '-m', message]) === null) {
    log('WARN', 'scaffold_commit_failed', { root, at: 'commit', identity: hasIdentity ? 'operator' : 'fallback' });
    return [];
  }
  const head = git(root, ['rev-parse', '--short', 'HEAD']) ?? '';
  const files = staged.split('\n').filter(Boolean).length;
  log('INFO', 'scaffold_commit', { root, head, files: String(files) });
  return [];
}
