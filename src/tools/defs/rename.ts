import type { Tool } from '../base.js';
import { resolveAgainstCwd } from '../lib.js';
import { RenameRefusal, formatPlan, renameSymbol } from '../rename/index.js';

/**
 * `rename` — one symbol, every reference, in one operation.
 *
 * WHY IT EXISTS AS A TOOL. Renaming with `str_replace` renames what the agent has read and misses the
 * call in the file it never opened; renaming with `sed` matches inside `FooBar`, inside strings and
 * inside comments. Both leave a tree that does not build, and the second leaves one that builds and is
 * wrong. This does the whole set or refuses.
 *
 * The dangerous cases are language-specific and live with the language (`rename/csharp.ts`,
 * `rename/typescript.ts`): a Unity MonoBehaviour must be renamed WITH its file or the component stops
 * binding with no compiler error, a serialized field's name is the key its value is stored under in
 * every prefab, and a TS object shorthand `{ Foo }` is a key as well as a value.
 */
export const tool: Tool = {
  name: 'rename',
  icon: '↻',
  description:
    'Rename a symbol and EVERY reference to it, across C# or TypeScript/JS files, in one operation. '
    + 'Prefer this over str_replace or a shell sed for any rename: it matches whole identifiers only (never inside '
    + 'FooBar), never edits strings or comments but REPORTS them, and handles the cases that break silently — a Unity '
    + 'MonoBehaviour renamed with its file (Unity binds by file name), [FormerlySerializedAs] added when a serialized '
    + 'field is renamed (its name is the key every prefab stores the value under), and TS object shorthand expanded so '
    + 'a data KEY does not follow a symbol. Run with dry_run first to see the plan.',
  parameters: [
    { name: 'symbol', type: 'string', description: 'The identifier to rename, exactly as written in code', required: true },
    { name: 'to', type: 'string', description: 'The new identifier', required: true },
    { name: 'path', type: 'string', description: 'File or directory to rename within (default: the working directory)', required: false },
    { name: 'dry_run', type: 'string', description: '"true" to report the plan without writing anything', required: false },
  ],
  async execute(params) {
    const symbol = String(params.symbol ?? '').trim();
    const to = String(params.to ?? '').trim();
    if (!symbol || !to) return 'Error: symbol and to required';
    const root = resolveAgainstCwd(String(params.path ?? '.').trim() || '.');
    const dryRun = String(params.dry_run ?? '').trim().toLowerCase() === 'true';
    try {
      const plan = renameSymbol({ symbol, to, root, dryRun });
      return formatPlan(plan, root, dryRun);
    } catch (e) {
      // A refusal is an ANSWER — an invalid identifier, a keyword, a collision — and reads as one. Anything
      // else is a real failure and keeps its message, because a rename that half-ran must say so.
      if (e instanceof RenameRefusal) return `Refused: ${e.message}`;
      return `Error: rename failed — ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};
