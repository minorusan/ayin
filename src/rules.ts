/**
 * Rules — the repository's own instructions, put in front of the model in full on every turn.
 *
 * Sources (in order, combined):
 *   1. `<repo>/.ayin/<file>` for each name in REPO_FILES, where <repo> is the git toplevel of the
 *      working directory (the working directory itself outside a repo). `ayin.md` is the first and,
 *      today, only one: the repo's conventions, its forbidden moves, and how to build and redeploy it.
 *   2. --rules "..." CLI flag
 *
 * WHY `.ayin/` AND NOT `AYIN.md` AT THE ROOT. Everything ayin owns in a repo already lives in
 * `.ayin/` (see ayin-dir.ts); the rules file is the one piece of it the repo's owners write and
 * commit, so `.ayin/.gitignore` re-includes it. A root `AYIN.md` is no longer read — a repo that still
 * has one is told so at startup rather than silently ignored.
 *
 * WHERE THEY GO. `buildMessages` puts them first in the system message, above the identity prompt,
 * every round and every chat reply; the planner gets them as its system message. Never summarised,
 * never trimmed: they are inside the prefix that `trimToContext` keeps whole.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { log } from './log.js';
import { getPrompt } from './prompts.js';

/** Files read from `<repo>/.ayin/`, in this order. */
const REPO_FILES = ['ayin.md'];

let rules = '';
let sources: string[] = [];

function repoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || cwd;
  } catch {
    return cwd; // not a git repo — the working directory is the project
  }
}

export function loadRules(cwd: string): void {
  const parts: string[] = [];
  sources = [];
  const root = repoRoot(cwd);

  for (const name of REPO_FILES) {
    const file = join(root, '.ayin', name);
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf-8').trim();
    if (!content) continue;
    const label = relative(cwd, file) || file;
    parts.push(`<!-- ${label} -->\n${content}`);
    sources.push(label);
    log('INFO', 'rules_loaded', { source: file, length: String(content.length) });
  }

  const legacy = join(root, 'AYIN.md');
  if (existsSync(legacy)) {
    log('WARN', 'rules_legacy_ignored', { source: legacy, moveTo: join(root, '.ayin', 'ayin.md') });
  }

  // --rules flag
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rules' && args[i + 1]) {
      parts.push(args[i + 1]);
      sources.push('--rules');
      break;
    }
    if (args[i].startsWith('--rules=')) {
      parts.push(args[i].slice('--rules='.length));
      sources.push('--rules');
      break;
    }
  }

  rules = parts.join('\n\n').trim();
}

export function getRules(): string {
  return rules;
}

/** What was loaded, for the startup line — e.g. `.ayin/ayin.md`. Empty when nothing was. */
export function getRuleSources(): string[] {
  return sources;
}

/** A root `AYIN.md` exists and is not read: the startup notice tells the operator where it goes now. */
export function legacyRulesPath(cwd: string): string | null {
  const legacy = join(repoRoot(cwd), 'AYIN.md');
  return existsSync(legacy) ? legacy : null;
}

/** The rules wrapped for a prompt (`prompts/ayin/repoRules.txt`), or '' when there are none. */
export function rulesBlock(): string {
  return rules ? getPrompt('repoRules', { RULES: rules }) : '';
}

/** The rules as a leading system message for a one-shot call (the planner), or none. */
export function rulesMessages(): { role: 'system'; content: string }[] {
  const block = rulesBlock();
  return block ? [{ role: 'system', content: block }] : [];
}
