import type { Tool } from '../base.js';
import { FIND_LIMIT, boolParam, execAsync, resolveAgainstCwd, shq, suggestSimilarPaths } from '../lib.js';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const CWD = process.cwd();

/**
 * GENERATED AND VENDORED TREES, PRUNED — the same set `grep`, `explore` and `find_references` prune.
 *
 * `find_files` pruned `node_modules` and `.git` and nothing else, which on a Unity project means the
 * answer is `Library/PackageCache`. Measured on a real one: `*.prefab` from the repo root returned
 * FIFTEEN results and every single one was a vendored package sample — zero project prefabs, on a
 * project with hundreds. The caller's next move is to guess a narrower path, which is the search it
 * was already trying to avoid doing by hand.
 *
 * `Library/`, `Temp/` and `obj/` are regenerable caches Unity rewrites on import; `Build`/`dist`/
 * `out` are output. None of them is ever the answer to "where is this file", and a caller who truly
 * wants one can say so with an explicit `path` into it — the prune is on the walk, not on the root.
 */
const PRUNED = [
  'node_modules', '.git', 'Library', 'Temp', 'obj', 'bin', 'Build', 'Builds', 'dist', 'out',
  '.venv', '__pycache__', 'coverage',
].map((d) => `-not -path '*/${d}/*'`).join(' ');

export const tool: Tool = {
    name: 'find_files',
    icon: '🔎',
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
        `find ${shq(String(params.path))}${depthArg} ${flag} ${shq(pattern)}${newer}${excl} ${PRUNED} | head -${FIND_LIMIT + 1}`,
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
        /**
         * A MISS SHOULD SAY WHERE THESE FILES DO LIVE, not list ways to guess again.
         *
         * `find_files path=Assets/Games/SolitaireGame pattern=*.controller` returned nothing, and the
         * advice it gave — try ignore_case, try a wider glob — was all about the PATTERN, when the
         * pattern was right and the directory was wrong: every controller in that project sits under
         * `Assets/Art/Animations`. So the caller re-ran the identical pattern one directory up and
         * got the answer. Reported verbatim: *"a no match → here is where similar names DO live hint
         * would save a round-trip."*
         *
         * The second search only runs on a miss, is bounded, and reports DIRECTORIES with counts
         * rather than paths — the question it answers is "where should I have looked", and a list of
         * two hundred files answers a different one.
         */
        let elsewhere = '';
        const searched = resolveAgainstCwd(String(params.path));
        if (searched !== CWD) {
          try {
            const wider = await execAsync(
              `find ${shq(CWD)} ${flag} ${shq(pattern)} ${PRUNED} | head -200`,
              { cwd: CWD },
            );
            const hits = wider === '(no output)' ? [] : wider.split('\n').filter((l) => l.trim());
            const byDir = new Map<string, number>();
            for (const h of hits) {
              const d = h.slice(0, h.lastIndexOf('/')).replace(`${CWD}/`, '');
              byDir.set(d, (byDir.get(d) ?? 0) + 1);
            }
            const top = [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
            if (top.length) {
              // `head -200` makes the count a FLOOR, not a total. Printing it as a total would be a
              // small lie in a message whose whole job is to be trusted about where things are.
              elsewhere = `\nThe same pattern DOES match elsewhere in this project — `
                + `${hits.length >= 200 ? 'at least 200' : `${hits.length}`} file(s), mostly in:\n`
                + top.map(([d, n]) => `  ${d}/  (${n})`).join('\n')
                + `\nRe-run with one of those as path=.`;
            }
          } catch { /* the wider look is a courtesy; its failure is not this call's failure */ }
        }
        return (
          `0 files match ${pattern} under ${params.path} (matched against the ${kind}).\n` +
          `The directory was searched successfully. Next: ignore_case=true, a wider glob like "*Ball*.cs", ` +
          `or a path glob such as "*/GameServices/*.cs".${elsewhere}`
        );
      }
      if (lines.length > FIND_LIMIT) {
        return `${lines.slice(0, FIND_LIMIT).join('\n')}\n(showing the first ${FIND_LIMIT} — there are MORE; narrow the pattern)`;
      }
      return `${lines.join('\n')}\n(${lines.length} file${lines.length === 1 ? '' : 's'})`;
    },
  };
