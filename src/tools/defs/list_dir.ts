import type { Tool } from '../base.js';
import { FIND_LIMIT, boolParam, resolveAgainstCwd, suggestSimilarPaths } from '../lib.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `list_dir` — what is in this directory, which had NO tool at all until now.
 *
 * THE MEASUREMENT THAT PRODUCED IT: across 483 recorded sessions, `bash` was 20% of every tool call, and
 * `ls -la …` was its single most common command — 177 of 826. Not because listing needs a shell, but
 * because nothing else could do it. Every one of those calls returned unbounded output through a general
 * shell, on a turn that only wanted to know what was there.
 *
 * WHAT IT SHOWS, and why each part is here rather than in a second call: name, whether it is a directory,
 * size and how long ago it changed. The mtime is the load-bearing one — "which of these did the last run
 * touch" is the question a listing is usually a step toward, and without it the answer is another call.
 *
 * BOUNDED, SORTED, AND HONEST ABOUT TRUNCATION. Directories first then names, capped, and the cap says so
 * — a listing that silently shows the first 30 of 2000 entries is how a model concludes a file is absent.
 * `Library/` on a Unity project is hundreds of thousands of entries; the cap is what makes this safe to
 * point anywhere.
 */
export const tool: Tool = {
  name: 'list_dir',
  description:
    'List a directory: names, dir/file, size, and how recently each changed. Prefer this over `ls` in bash — '
    + 'it is bounded, sorted (directories first), and says when it truncated. Use recursive=true for a shallow '
    + 'tree, or find_files when you already know the name pattern.',
  parameters: [
    { name: 'path', type: 'string', description: 'Directory to list', required: true },
    { name: 'recursive', type: 'boolean', description: 'Also list one level inside each subdirectory', required: false },
    { name: 'all', type: 'boolean', description: 'Include dotfiles', required: false },
    { name: 'limit', type: 'number', description: `Max entries (default ${FIND_LIMIT}, max 300)`, required: false },
  ],
  async execute(params) {
    if (!params.path) return 'Error: path required';
    const root = resolveAgainstCwd(String(params.path));
    if (!existsSync(root)) return `Error: path not found: ${params.path}.${suggestSimilarPaths(String(params.path))}`;
    let st;
    try { st = statSync(root); } catch (e) { return `Error: cannot stat ${params.path} — ${e instanceof Error ? e.message : String(e)}`; }
    if (!st.isDirectory()) return `${params.path} is a FILE (${st.size} bytes) — use read_file for its contents.`;

    const showAll = boolParam(params.all);
    const cap = Math.min(Math.max(Math.floor(Number(params.limit) || FIND_LIMIT), 1), 300);
    const rows: Array<{ label: string; dir: boolean; size: number; ms: number }> = [];
    let total = 0;

    const scan = (dir: string, prefix: string, depth: number): void => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names.sort()) {
        if (!showAll && name.startsWith('.')) continue;
        total++;
        if (rows.length >= cap) continue;
        const full = join(dir, name);
        let s;
        try { s = statSync(full); } catch { continue; }
        const isDir = s.isDirectory();
        rows.push({ label: `${prefix}${name}${isDir ? '/' : ''}`, dir: isDir, size: s.size, ms: s.mtimeMs });
        // One level in, and never into the caches — a Unity `Library/` or a `node_modules` would spend the
        // whole cap on generated files and answer nothing.
        if (isDir && depth > 0 && !/^(node_modules|Library|Temp|obj|dist|build|out|\.git)$/.test(name)) {
          scan(full, `${prefix}${name}/`, depth - 1);
        }
      }
    };
    scan(root, '', boolParam(params.recursive) ? 1 : 0);

    if (!rows.length) return `${params.path} is EMPTY${showAll ? '' : ' (or holds only dotfiles — pass all=true)'}.`;
    rows.sort((a, b) => (a.dir === b.dir ? a.label.localeCompare(b.label) : a.dir ? -1 : 1));
    const lines = rows.map((r) => `${r.dir ? 'dir ' : '    '}${human(r.size).padStart(7)}  ${ago(r.ms).padStart(8)}  ${r.label}`);
    const tail = total > rows.length
      ? `\n(showing ${rows.length} of ${total} entries — raise limit=, or use find_files with a pattern)`
      : `\n(${rows.length} entr${rows.length === 1 ? 'y' : 'ies'})`;
    return lines.join('\n') + tail;
  },
};

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)}M`;
  return `${(bytes / 1073741824).toFixed(1)}G`;
}

/** Relative, because "2h ago" answers "did this turn touch it" and a timestamp does not. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
