import type { Tool } from '../base.js';
import { FIND_LIMIT, GREP_LIMIT, boolParam, execAsync, resolveAgainstCwd, shq, suggestSimilarPaths } from '../lib.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectProfile, guidBlock, rankGrepLines, type GrepProfile } from '../grep-rank.js';

const CWD = process.cwd();

/**
 * The ranked files that survived the cap.
 *
 * Annotating a file the reader cannot see is worse than not annotating: it reads as a hit that was
 * shown, and the line it belongs to was cut.
 */
function filesShownIn(shown: string[], ordered: string[]): string[] {
  const present = new Set(shown.map((l) => l.split(':')[0].split('-')[0]));
  return ordered.filter((f) => shown.some((l) => l.startsWith(`${f}:`) || l.startsWith(`${f}-`)) || present.has(f));
}

/**
 * Directories a code search must never descend into.
 *
 * WATCHED IT HAPPEN. On a Unity repo, `grep pattern .` returned `.git/COMMIT_EDITMSG`,
 * `.git/packed-refs` and `.git/info/refs` among its first six hits — three of the model's opening
 * facts were git plumbing. That is not merely noise: `COMMIT_EDITMSG` and the various `*_MSG` files
 * are PROSE ABOUT CODE, often code that has since changed or been deleted, and it arrives looking
 * exactly like a source match. It is the same class of evidence as a stale corpus note.
 *
 * The cost is also flat waste: the result cap is spent on plumbing, and `Library/` on a Unity project
 * is gigabytes of imported artifacts that no question is ever about.
 *
 * An EXPLICIT path still wins — `--exclude-dir` prunes directories grep would recurse INTO, not the
 * one it was pointed at, so `path=Library` searches Library exactly as before. The rule is "do not
 * wander into these", never "you may not look here".
 */
const NEVER_RECURSE = [
  '.git', 'node_modules',
  'Library', 'Temp', 'obj', 'Logs', // Unity: imported artifacts and build scratch
  'dist', 'build', 'out', '.next', 'coverage', '__pycache__', '.venv', 'vendor',
];

export const tool: Tool = {
    name: 'grep',
    icon: '🔍',
    description: 'Search file contents RECURSIVELY under a directory (or in one file). The pattern is an EXTENDED regex — alternation (a|b), ?, +, () all work. Returns matching lines with file paths and line numbers. Prefer this over a shell grep: it prunes .git/node_modules/Library/dist, caps output, RANKS hits so first-party code outranks third-party and the most relevant file kind comes first (per project type — Unity ranks .cs over .asset over .controller and reports the GUID of each script it names), and takes exclude/count/only_matching/invert so a second pass or a pipe is rarely needed.',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Extended-regex pattern, e.g. "IsPickBooster|_skippedBalls"', required: true },
      { name: 'path', type: 'string', description: 'Directory or file to search', required: true },
      { name: 'include', type: 'string', description: 'File glob filter, e.g. "*.ts"', required: false },
      { name: 'ignore_case', type: 'boolean', description: 'Case-insensitive match', required: false },
      { name: 'fixed', type: 'boolean', description: 'Treat the pattern as a literal string, not a regex', required: false },
      { name: 'context', type: 'number', description: 'Also return N lines around each match — read the code without a second call', required: false },
      { name: 'files_only', type: 'boolean', description: 'List only the file paths that match, not the lines — use first to see how widely something spreads', required: false },
      { name: 'exclude', type: 'string', description: 'Drop matching lines that ALSO match this regex — the second grep of a `grep X | grep -v Y` chain, in one call', required: false },
      { name: 'invert', type: 'boolean', description: 'Return the lines that do NOT match — for filtering noise out rather than finding something', required: false },
      { name: 'count', type: 'boolean', description: 'Return per-file MATCH COUNTS instead of lines — how much of this is there, before deciding whether to read it', required: false },
      { name: 'only_matching', type: 'boolean', description: 'Return only the matched text, not the whole line — how to list every symbol/name a pattern finds', required: false },
      { name: 'max_matches', type: 'number', description: 'Cap the results at N (default 50, or 30 files) — the `| head -N` of a shell grep', required: false },
      { name: 'profile', type: 'string', description: 'Ranking profile: unity | typescript | general. Detected from the repo by default — pass it only to override that', required: false },
    ],
    async execute(params) {
      if (!params.pattern || !params.path) return 'Error: pattern and path required';
      if (!existsSync(resolveAgainstCwd(params.path))) {
        return `Error: path not found: ${params.path}.${suggestSimilarPaths(params.path)}`;
      }
      // -E, not the default BRE. A model writes `a|b`, `.?`, `foo+` — under BRE those are LITERAL
      // characters, so the search silently matched nothing and the agent concluded the code did not
      // exist (measured on a Unity repo: `Pick 1|Pick1|pick1` → 0 hits where real ERE found 36 files).
      // `files_only` answers "how widely does this spread" in one call; `context` answers "what does
      // the code around it say" without the offset/limit groping that follows every bare match (a real
      // run spent three read_file calls hunting around a line number it already had).
      /**
       * THE FLAGS A MODEL ACTUALLY REACHES FOR, measured rather than guessed.
       *
       * 1418 of one agent's 2569 shell commands contained `grep`, and 97% of those PIPED it somewhere:
       * 1195 into a second `grep` (narrowing), 1081 into `head` (capping), and the flag histogram was
       * `-n` 910 · `-vE` 816 · `-c` 297 · `-oE`/`-o` 234 · `-l` 44. Every one of those is a param here
       * now — `exclude` is the second grep, `max_matches` is the head, `invert`/`count`/`only_matching`
       * are the three flags that were missing. A tool that cannot express the thing a shell one-liner
       * expresses does not get used; it gets worked around, and the workaround is unbounded output.
       */
      const filesOnly = boolParam(params.files_only);
      const counting = boolParam(params.count);
      const onlyMatching = boolParam(params.only_matching);
      const ctxLines = Math.min(Math.max(Number(params.context) || 0, 0), 10);
      const mode = counting ? '-rc' : filesOnly ? '-rl' : onlyMatching ? '-ronH' : '-rn';
      const flags = [mode, boolParam(params.fixed) ? '-F' : '-E'];
      if (boolParam(params.ignore_case)) flags.push('-i');
      if (boolParam(params.invert)) flags.push('-v');
      if (ctxLines > 0 && !filesOnly && !counting && !onlyMatching) flags.push(`-C${ctxLines}`);
      const inc = params.include ? ` --include=${shq(String(params.include))}` : '';
      const prune = NEVER_RECURSE.map((d) => ` --exclude-dir=${shq(d)}`).join('');
      // With -C, most returned lines are context, so a flat 50-line cap would show ~8 matches and call
      // it the limit. The cap scales with the context requested; the label below says what was counted.
      const asked = Math.floor(Number(params.max_matches) || 0);
      const defaultCap = filesOnly || counting ? FIND_LIMIT : ctxLines > 0 ? GREP_LIMIT * (1 + ctxLines) : GREP_LIMIT;
      const cap = asked > 0 ? Math.min(asked, 500) : defaultCap;
      // Ask for one line MORE than shown, so truncation can be reported instead of silently cutting.
      // `exclude` is the `| grep -vE Y` half of the chain this tool exists to replace. Applied after the
      // search rather than inside it, because grep cannot express "matches X but not Y" in one pass.
      const excl = params.exclude ? ` | grep -vE -- ${shq(String(params.exclude))}` : '';
      // Counting prints `path:0` for every file grep looked at; only the non-zero lines are an answer.
      const zeroes = counting ? " | grep -vE ':0$'" : '';
      /**
       * SCAN WIDER THAN YOU SHOW, or the ranking is decorative.
       *
       * The `| head -N` used to cap at the display limit, which meant the shell threw away everything
       * past N in WALK ORDER before any ranking could see it — so ranking only ever reordered the
       * first N. Caught by testing: `MonoBehaviour` over a Unity `Assets/` returned ten TextMesh Pro
       * files and reported eleven third-party hits ranked last, because the first-party `.cs` matches
       * were cut by `head` before they were ever scored. The cap is a DISPLAY budget; the scan has to
       * be big enough for the sort to mean something, and bounded so a pathological pattern cannot
       * stream the repo through this process.
       */
      // A file list costs ONE SHORT LINE per result, so its scan can be far wider than a line
      // search's for the same bytes — and it needs to be. Measured: `MonoBehaviour` over a Unity
      // `Assets/` matches thousands of `.asset` YAML headers, and a 300-file scan never reached
      // `Assets/Games` at all, so every first-party `.cs` was outside the window the sort could see.
      const scan = filesOnly || counting ? 2000 : Math.min(Math.max(cap * 10, 200), 2000);
      const out = await execAsync(
        // `--include` MUST precede `--`: after the terminator grep reads every argument as a file
        // operand, so the filter became a missing filename ("grep: --include=*.cs: No such file")
        // and quietly stopped filtering. Caught by watching a real run, not by the build.
        `grep ${flags.join(' ')}${inc}${prune} -- ${shq(String(params.pattern))} ${shq(String(params.path))}${zeroes}${excl} | head -${scan + 1}`,
        { cwd: CWD },
      );
      const raw = out === '(no output)' ? [] : out.split('\n').filter((l) => l.trim());
      // RANK BEFORE CAPPING, which is the whole point: capping first would spend the 50 lines on
      // whatever the filesystem walk happened to reach, and on a Unity repo that opened with
      // `Assets/Plugins/…` and `Assets/Spine/Editor/…` — third-party code, ahead of every file the
      // team can actually change. The cap is a budget, and ranking decides what it buys.
      const profile: GrepProfile = ['unity', 'typescript', 'general'].includes(String(params.profile))
        ? String(params.profile) as GrepProfile
        : detectProfile(CWD);
      // Grep gave up at the scan budget, so there is more than was even considered — a different
      // fact from "more than was shown", and the advice that follows differs too.
      const scanTruncated = raw.length > scan;
      const ranked = rankGrepLines(CWD, raw.slice(0, scan), profile);
      const lines = ranked.lines;
      if (!lines.length) {
        // An empty result must read as "your pattern matched nothing", never as "this code does not
        // exist" — that misreading is what sends the loop off hunting with ls/find.
        return (
          `0 matches for ${params.pattern} in ${params.path}${params.include ? ` (include=${params.include})` : ''}.\n` +
          `The path was searched successfully — the pattern is what missed. Next: a shorter distinctive ` +
          `substring, ignore_case=true, fixed=true for a literal, or drop include=.`
        );
      }
      // Say what was counted: with -C most lines are context, and with -l they are files, so calling
      // either "matches" would misstate the result the model reasons from.
      // Explicit pairs, because `${unit}s` produced "2 matchs" and "2 file with matchess" — the label is
      // what the model reasons from, and a mangled one reads as a mangled result.
      const [one, many] = counting ? ['file with matches', 'files with matches']
        : filesOnly ? ['file', 'files']
          : onlyMatching ? ['matched string', 'matched strings']
            : ctxLines > 0 ? ['line (incl. context)', 'lines (incl. context)']
              : ['match', 'matches'];
      const unit = one;
      const plural = (n: number) => (n === 1 ? one : many);
      // What was pushed down is SAID, not silently dropped: a hit in a plugin is occasionally the
      // answer, and an agent that cannot tell "no third-party match" from "third-party matches you
      // were not shown" will re-run the same search wider.
      const sunk = ranked.thirdParty.length
        ? `\n(${ranked.thirdParty.length} third-party file(s) ranked last: ${ranked.thirdParty.slice(0, 3).join(', ')}${ranked.thirdParty.length > 3 ? ', …' : ''})`
        : '';
      if (lines.length > cap || scanTruncated) {
        const shown = lines.slice(0, cap);
        const guids = profile === 'unity' ? guidBlock(CWD, filesShownIn(shown, ranked.files)) : '';
        // RANKING WAS PARTIAL AND MUST SAY SO. Sorting a window is not sorting the result, and an
        // agent told only "there are MORE" will read the top hit as the best in the repo when it is
        // merely the best of the first two thousand grep reached.
        const partial = scanTruncated
          ? ` — and MORE than the ${scan} scanned, so this ranking covers only what was scanned; narrow the pattern or add include=`
          : ' — there are MORE; narrow the pattern, add include=, or use files_only=true to see the spread';
        return `${shown.join('\n')}\n(showing the first ${cap} ${plural(cap)}${partial})${sunk}${guids}`;
      }
      const guids = profile === 'unity' ? guidBlock(CWD, ranked.files) : '';
      return `${lines.join('\n')}\n(${lines.length} ${plural(lines.length)})${sunk}${guids}`;
    },
  };
