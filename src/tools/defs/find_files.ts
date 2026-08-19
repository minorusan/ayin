import type { Tool } from '../base.js';
import { FIND_LIMIT, boolParam, execAsync, resolveAgainstCwd, shq, suggestSimilarPaths } from '../lib.js';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const CWD = process.cwd();

export const tool: Tool = {
    name: 'find_files',
    description: 'Find files by name, recursively. Takes max_depth, modified_since ("2h", "3d") and exclude, so a shell `find` is rarely needed. A pattern containing "/" is matched against the whole path (e.g. "*/GameServices/*.cs"); otherwise against the file name. Returns matching file paths.',
    parameters: [
      { name: 'path', type: 'string', description: 'Directory to search in', required: true },
      { name: 'pattern', type: 'string', description: 'Glob: "*.ts", "package.json", or a path glob like "*/handlers/*.ts"', required: true },
      { name: 'ignore_case', type: 'boolean', description: 'Case-insensitive match', required: false },
      { name: 'max_depth', type: 'number', description: 'Do not descend deeper than N levels — a shallow look before a whole-tree one', required: false },
      { name: 'modified_since', type: 'string', description: 'Only files changed recently: "30m", "6h", "2d" — what a turn actually touched', required: false },
      { name: 'exclude', type: 'string', description: 'Skip paths matching this glob, e.g. "*/Tests/*"', required: false },
    ],
    async execute(params) {
      if (!params.path || !params.pattern) return 'Error: path and pattern required';
      if (!existsSync(resolveAgainstCwd(params.path))) {
        return `Error: path not found: ${params.path}.${suggestSimilarPaths(params.path)}`;
      }
      // `-name` only ever sees the basename, so a model passing "*/handlers/*.ts" got nothing. Route a
      // pattern that contains a separator to -path, which is what it plainly means.
      const pattern = String(params.pattern);
      const kind = pattern.includes('/') ? 'path' : 'name';
      const flag = boolParam(params.ignore_case) ? `-i${kind}` : `-${kind}`;
      /**
       * DEPTH, RECENCY AND AN EXCLUDE — the three reasons a model went back to shell `find` (76 of 826
       * calls in the measured transcripts). `-maxdepth` must precede the tests or find warns and ignores
       * it; `-newermt` takes the relative forms people actually think in ("2 hours ago"), which is why the
       * unit is translated here rather than demanding a timestamp nobody has.
       */
      const depth = Math.floor(Number(params.max_depth) || 0);
      const depthArg = depth > 0 ? ` -maxdepth ${Math.min(depth, 20)}` : '';
      const since = String(params.modified_since ?? '').trim();
      const m = /^(\d+)\s*(m|h|d)$/i.exec(since);
      const newer = m
        ? ` -newermt ${shq(`${m[1]} ${{ m: 'minutes', h: 'hours', d: 'days' }[m[2].toLowerCase() as 'm' | 'h' | 'd']} ago`)}`
        : '';
      const excl = params.exclude ? ` -not -path ${shq(String(params.exclude))}` : '';
      const out = await execAsync(
        `find ${shq(String(params.path))}${depthArg} ${flag} ${shq(pattern)}${newer}${excl} -not -path '*/node_modules/*' -not -path '*/.git/*' | head -${FIND_LIMIT + 1}`,
        { cwd: CWD },
      );
      // find prints in TRAVERSAL order, so `head` used to hand back whatever the filesystem yielded
      // first — an exact-name match could lose its place to thirty generated siblings. Rank before
      // cutting: exact basename, then prefix, then the shallowest path (the main file usually sits
      // above its tests and generated copies).
      const stem = basename(pattern).replace(/[*?]/g, '').toLowerCase();
      const rankScore = (p: string): number => {
        const b = basename(p).toLowerCase();
        let s = 0;
        if (stem && b === stem) s -= 1000;
        else if (stem && b.startsWith(stem)) s -= 500;
        return s + p.split('/').length;
      };
      const lines = (out === '(no output)' ? [] : out.split('\n').filter((l) => l.trim())).sort(
        (a, b) => rankScore(a) - rankScore(b),
      );
      if (!lines.length) {
        return (
          `0 files match ${pattern} under ${params.path} (matched against the ${kind}).\n` +
          `The directory was searched successfully. Next: ignore_case=true, a wider glob like "*Ball*.cs", ` +
          `or a path glob such as "*/GameServices/*.cs".`
        );
      }
      if (lines.length > FIND_LIMIT) {
        return `${lines.slice(0, FIND_LIMIT).join('\n')}\n(showing the first ${FIND_LIMIT} — there are MORE; narrow the pattern)`;
      }
      return `${lines.join('\n')}\n(${lines.length} file${lines.length === 1 ? '' : 's'})`;
    },
  };
