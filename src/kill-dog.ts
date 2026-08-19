/**
 * kill-dog.ts — `ayin kill dog`: every hound stands down, and stays down.
 *
 * WHY THIS EXISTS ALONGSIDE `unwatch`. `unwatch` ends a WATCH: it removes the hooks ayin installed in
 * one repo and deregisters it. Two things escape that, and both were reported as "unwatch does not
 * disable the hound":
 *
 *   1. A repo that was never registered. The hound is a Stop hook in a repo's own
 *      `.claude/settings.json`, and a hound put there by hand — or by another tool, or by an earlier
 *      version of this one, or by a coding agent following a note in CLAUDE.md — is not in
 *      `~/.ayin-cli/watch/repos.json`. `unwatch` has nothing to look at. Nothing ayin can uninstall
 *      will stop a hook ayin does not own.
 *   2. The daemon's self-heal. While a repo IS registered, deleting the hook by hand is undone within
 *      five minutes, because a missing hook is indistinguishable from a fresh clone.
 *
 * So this command does not uninstall anything as its primary act — it throws a SWITCH every hound
 * honours (`hound-off.ts`), which is the only mechanism that reaches a hook in a repo ayin has never
 * heard of. Then, as housekeeping, it removes ayin's own hound from the repos it does know about, so a
 * killed dog is not merely muzzled but gone from the files it was installed into.
 *
 * A FOREIGN hound is REPORTED, NEVER DELETED. Removing another tool's hook entry is the one thing
 * `unwatch`'s design is emphatic about not doing, and a `kill dog` that quietly edited a hand-written
 * hook would be worse than the barking. Instead it says which script it found, and whether that
 * script honours the switch — one `[ -f ]` test is all a bash hound needs to join in.
 *
 * Reversible on purpose: `ayin kill dog --off`. A kill switch with no way back is a trap for whoever
 * inherits the machine.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// hound-off.js ONLY — importing watch.js would drag in the LLM manager and blessed's module-scope
// screen, so a hook-killing command would open a TUI to find out what the hook is called.
import {
  HOUND_MARKERS, HOUND_SCRIPT_NAME, LEGACY_HOUND_SCRIPT,
  houndOffPath, houndOffSince, isHoundOff, setHoundOff,
} from './hound-off.js';

const REPOS_FILE = join(homedir(), '.ayin-cli', 'watch', 'repos.json');

interface HookEntry { command?: string }
interface HookGroup { hooks?: HookEntry[] }
interface Settings { hooks?: { [event: string]: HookGroup[] }; [k: string]: unknown }

const out = (line: string): void => { process.stdout.write(`${line}\n`); };

/** Repos ayin registered — the only ones whose hound it may remove. */
function watchedRepos(): string[] {
  if (!existsSync(REPOS_FILE)) return [];
  try { return Object.keys(JSON.parse(readFileSync(REPOS_FILE, 'utf-8')) as Record<string, unknown>); }
  catch { return []; }
}

/** Read one repo's Claude settings, or null when there are none / it is hand-broken. */
function settingsOf(repo: string): { path: string; settings: Settings } | null {
  const path = join(repo, '.claude', 'settings.json');
  if (!existsSync(path)) return null;
  try { return { path, settings: JSON.parse(readFileSync(path, 'utf-8')) as Settings }; }
  catch { return null; }
}

const isOurs = (cmd: string): boolean => HOUND_MARKERS.some((m) => cmd.includes(m));

/**
 * Remove AYIN's hound from one repo: the script, the bash one it replaced, and only the Stop group
 * whose command names one of them. Same identity test `unwatch` uses (`HOUND_MARKERS`), so the two
 * commands can never disagree about what "ours" means.
 */
function removeOurHound(repo: string): boolean {
  let touched = false;
  for (const script of [HOUND_SCRIPT_NAME, LEGACY_HOUND_SCRIPT]) {
    const path = join(repo, '.claude', 'hooks', script);
    if (!existsSync(path)) continue;
    try { unlinkSync(path); out(`  ${repo}: ${script} removed`); touched = true; }
    catch (e) { out(`  ${repo}: could not remove ${script} (${e instanceof Error ? e.message : String(e)})`); }
  }
  const s = settingsOf(repo);
  if (!s) return touched;
  const groups = s.settings.hooks?.Stop ?? [];
  const kept = groups.filter((g) => !g.hooks?.some((h) => isOurs(h.command ?? '')));
  if (kept.length === groups.length) return touched;
  // Drop the KEY when nothing is left rather than leaving `"Stop": []` in the operator's file.
  if (kept.length) s.settings.hooks!.Stop = kept;
  else delete s.settings.hooks?.Stop;
  if (s.settings.hooks && Object.keys(s.settings.hooks).length === 0) delete s.settings.hooks;
  writeFileSync(s.path, `${JSON.stringify(s.settings, null, 2)}\n`);
  out(`  ${repo}: Stop entry removed from .claude/settings.json`);
  return true;
}

/** Foreign Stop hooks that look like a hound, and whether each one honours the switch. */
function reportForeignHounds(repo: string): number {
  const s = settingsOf(repo);
  if (!s) return 0;
  let found = 0;
  for (const g of s.settings.hooks?.Stop ?? []) {
    for (const h of g.hooks ?? []) {
      const cmd = h.command ?? '';
      if (!cmd || isOurs(cmd) || !/hound|premortem/i.test(cmd)) continue;
      found++;
      // The script path as written in the command, with Claude Code's variable resolved, so the
      // honour check reads the file that will actually run.
      const m = /(?:"|')?([^"'\s]*(?:hound|premortem)[^"'\s]*)(?:"|')?/i.exec(cmd);
      const path = m ? m[1].replace('$CLAUDE_PROJECT_DIR', repo).replace('${CLAUDE_PROJECT_DIR}', repo) : '';
      let honours = false;
      try { honours = path ? readFileSync(path, 'utf-8').includes('hound.off') : false; } catch { honours = false; }
      out(`  ${repo}: FOREIGN hound — ${cmd}`);
      out(honours
        ? '    honours the switch: it will pass instantly while the dog is killed'
        : `    does NOT honour the switch — not ayin's to delete. Add this as its first line:\n`
          + `      [ -f "${houndOffPath()}" ] && exit 0`);
    }
  }
  return found;
}

/** The repo we are standing in, if it is one — a hound here is the one the operator just met. */
function cwdRepo(): string | null {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = join(dir, '..');
    if (up === dir) return null;
    dir = up;
  }
}

export function runKillDog(args: string[]): number {
  const revive = args.includes('--off') || args.includes('--revive');
  const statusOnly = args.includes('--status');

  if (statusOnly) {
    const since = houndOffSince();
    out(isHoundOff()
      ? `the dog is dead — ${houndOffPath()}${since ? ` (since ${since})` : ''}`
      : 'the dog is alive — hounds run on Stop as usual');
    return 0;
  }

  if (revive) {
    const changed = setHoundOff(false);
    out(changed
      ? 'the dog lives. New `ayin watch` installs and the daemon self-heal will re-add the hound.'
      : 'the dog was already alive — nothing to do.');
    if (changed) out('Repos that had their hound REMOVED do not get it back until they are watched again.');
    return 0;
  }

  const changed = setHoundOff(true);
  out(changed
    ? `dog killed — every hound now exits 0 instantly (switch: ${houndOffPath()})`
    : `the dog was already dead (switch: ${houndOffPath()})`);

  // Housekeeping: ours, out of the repos we know about, plus wherever we are standing.
  const repos = [...new Set([...watchedRepos(), ...(cwdRepo() ? [cwdRepo() as string] : [])])];
  let removed = 0;
  let foreign = 0;
  for (const repo of repos) {
    if (!existsSync(repo)) continue;
    if (removeOurHound(repo)) removed++;
    foreign += reportForeignHounds(repo);
  }
  out(`checked ${repos.length} repo(s): ayin's hound removed from ${removed}, ${foreign} foreign hound(s) found`);
  if (!foreign) out('Nothing else barks from here. `ayin kill dog --off` brings it back.');
  return 0;
}

/** Kept separate so `ayin --help` can print the same words the command answers to. */
export const KILL_DOG_USAGE = 'ayin kill dog [--off | --status]';
