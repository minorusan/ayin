/**
 * A live probe for the skeptic pass — the deterministic half printed, then the real model call.
 *
 * `npx tsx src/qa/_skepticprobe.ts` from the repo root. It reviews whatever is dirty in THIS working
 * tree, which is the honest test: a real diff with real callers, not a fixture.
 *
 * Underscore-prefixed and never imported by anything shipped — the same convention as the other
 * probes in this repo.
 */

import { blastRadius, skepticCard, skepticPass } from './skeptic.js';
import { describeFile, gitDirtySet, projectRoot } from './probes.js';

/**
 * The card, flattened HERE rather than through `qa/index.ts#cardToText`.
 *
 * That module imports `ui.ts`, which builds a blessed screen at import time — so a probe that only
 * wanted a two-line formatter took over the terminal with an alternate-screen buffer and printed its
 * output into a TUI nobody asked for. Six lines of local rendering, and the probe stays a probe.
 */
function flatten(c: { title: string; body: string[]; footer?: string }): string {
  return [c.title, ...c.body.map((l) => `  ${l}`), c.footer ? `  ${c.footer}` : ''].filter(Boolean).join('\n');
}

async function main(): Promise<void> {
  const root = projectRoot();
  const dirty = [...(gitDirtySet() ?? new Set<string>())].filter((p) => /\.(ts|tsx|js|mjs)$/.test(p));
  const files = dirty.map(describeFile).filter((f) => f.exists);
  console.log(`root: ${root}\nfiles: ${files.length}\n${files.map((f) => `  ${f.path}`).join('\n')}\n`);
  if (files.length === 0) {
    console.log('nothing dirty to review — edit a file and run this again');
    return;
  }

  const radius = blastRadius(root, files);
  console.log(`── DIFF (${radius.diff.length} chars${radius.clipped ? ', clipped' : ''}) ──`);
  console.log(`${radius.diff.slice(0, 1200)}\n…\n`);
  console.log(`── CALLERS (${radius.callerCount} hit(s)) ──`);
  console.log(`${radius.callers.slice(0, 1600)}\n`);

  if (process.argv.includes('--dry')) return; // the deterministic half only, no model, no cost

  console.log('── asking the model ──');
  const t = Date.now();
  const result = await skepticPass(
    'widen the subagent port so find_relevant_files can pass a signal and narrate',
    'Done — the port takes signal and onStatus, the wiring forwards them, and the tool narrates three notes.',
    files,
    root,
  );
  console.log(`(${((Date.now() - t) / 1000).toFixed(1)}s)\n`);
  console.log(flatten(skepticCard(result)));
  console.log(`\nraw findings: ${JSON.stringify(result.findings, null, 1)}`);
}

/**
 * EXPLICIT EXIT. Importing the skeptic pulls in `llm/manager.js`, which the running agent keeps alive
 * on purpose — so a one-shot script finishes its work and then sits there with an open handle,
 * looking exactly like a hang. The agent is not affected; a probe just has to say when it is done.
 */
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1); });
