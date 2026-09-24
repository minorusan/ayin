/**
 * `edit_history` — every edit this agent made, in order, and whether each one still stands.
 *
 * The visible half of `edits/ledger.ts`. Before this, "what have I changed" was answerable only by
 * `git status`, which on a real project is a wall: the session that prompted this opened with 29
 * files already dirty — Addressables, ServerData, bundles — and the model's own one-file change was
 * a needle in it. Its report asked for exactly this: *"a 'diff since my last tool call' view would be
 * far more useful than raw porcelain."*
 *
 * THE STATE COLUMN IS THE POINT. Each record carries the hash of what its edit produced, so the
 * ledger can say whether the file is still that — `current`, `superseded` by a later recorded edit,
 * `undone`, `gone`, or `changed-outside`, which means something the agent did not do wrote the file.
 * Only the last of those is a reason to stop, and telling it apart from the others is what a git
 * status cannot do.
 */

import type { Tool } from '../base.js';
import { displayPath, history, stateOf } from '../../edits/ledger.js';
import { resolveAgainstCwd } from '../lib.js';

const MARK: Record<string, string> = {
  current: '✓ current',
  superseded: '· superseded by a later edit',
  undone: '↩ undone',
  gone: '! the file is gone',
  'changed-outside': '!! CHANGED by something other than a recorded edit',
};

export const tool: Tool = {
  name: 'edit_history',
  icon: '📜',
  description:
    'Every edit you have made this session, oldest first, with what each one did and whether the file '
    + 'is still in that state. Pass a path for one file. Use it instead of git status to see your own '
    + 'work: git shows everything dirty in the tree, most of which you did not touch. Read-only.',
  parameters: [
    { name: 'path', type: 'string', description: 'One file, to see only its edits. Omit for every edit this session.', required: false },
    { name: 'limit', type: 'number', description: 'Most recent N (default 30)', required: false },
  ],

  async execute(params) {
    const cwd = process.cwd();
    const path = params.path ? resolveAgainstCwd(String(params.path)) : undefined;
    const all = history(undefined, cwd);
    const rows = path ? all.filter((r) => r.path === path) : all;
    if (rows.length === 0) {
      return path
        ? `No recorded edit to ${params.path} this session.`
        : 'No edits recorded this session. Nothing you ran has changed a file through an edit tool.';
    }
    const asked = Number(params.limit);
    const limit = Number.isFinite(asked) && asked > 0 ? asked : 30;
    const shown = rows.slice(-limit);

    const out = [`${rows.length} edit(s)${path ? ` to ${displayPath(path, cwd)}` : ''}${shown.length < rows.length ? `, showing the last ${shown.length}` : ''}:`];
    for (const r of shown) {
      const state = stateOf(r, all);
      out.push(`  #${r.seq}  ${displayPath(r.path, cwd)}  ·  ${r.tool}  ·  ${MARK[state] ?? state}`);
      if (r.summary) out.push(`      ${r.summary}`);
    }
    const undoable = [...rows].reverse().find((r) => !r.undone);
    if (undoable) out.push('', `undo_edit would revert #${undoable.seq}.`);
    return out.join('\n');
  },
};
