import type { Tool } from '../base.js';
import { FIND_LIMIT, GREP_LIMIT, boolParam, execAsync, resolveAgainstCwd, shq, suggestSimilarPaths } from '../lib.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CWD = process.cwd();

export const tool: Tool = {
    name: 'grep',
    description: 'Search file contents. The pattern is an EXTENDED regex — alternation (a|b), ?, +, () all work. Returns matching lines with file paths and line numbers.',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Extended-regex pattern, e.g. "IsPickBooster|_skippedBalls"', required: true },
      { name: 'path', type: 'string', description: 'Directory or file to search', required: true },
      { name: 'include', type: 'string', description: 'File glob filter, e.g. "*.ts"', required: false },
      { name: 'ignore_case', type: 'boolean', description: 'Case-insensitive match', required: false },
      { name: 'fixed', type: 'boolean', description: 'Treat the pattern as a literal string, not a regex', required: false },
      { name: 'context', type: 'number', description: 'Also return N lines around each match — read the code without a second call', required: false },
      { name: 'files_only', type: 'boolean', description: 'List only the file paths that match, not the lines — use first to see how widely something spreads', required: false },
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
      const filesOnly = boolParam(params.files_only);
      const ctxLines = Math.min(Math.max(Number(params.context) || 0, 0), 10);
      const flags = [filesOnly ? '-rl' : '-rn', boolParam(params.fixed) ? '-F' : '-E'];
      if (boolParam(params.ignore_case)) flags.push('-i');
      if (ctxLines > 0 && !filesOnly) flags.push(`-C${ctxLines}`);
      const inc = params.include ? ` --include=${shq(String(params.include))}` : '';
      // With -C, most returned lines are context, so a flat 50-line cap would show ~8 matches and call
      // it the limit. The cap scales with the context requested; the label below says what was counted.
      const cap = filesOnly ? FIND_LIMIT : ctxLines > 0 ? GREP_LIMIT * (1 + ctxLines) : GREP_LIMIT;
      // Ask for one line MORE than shown, so truncation can be reported instead of silently cutting.
      const out = await execAsync(
        // `--include` MUST precede `--`: after the terminator grep reads every argument as a file
        // operand, so the filter became a missing filename ("grep: --include=*.cs: No such file")
        // and quietly stopped filtering. Caught by watching a real run, not by the build.
        `grep ${flags.join(' ')}${inc} -- ${shq(String(params.pattern))} ${shq(String(params.path))} | head -${cap + 1}`,
        { cwd: CWD },
      );
      const lines = out === '(no output)' ? [] : out.split('\n').filter((l) => l.trim());
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
      const unit = filesOnly ? 'file' : ctxLines > 0 ? 'line (incl. context)' : 'match';
      const plural = (n: number) => (n === 1 ? unit : filesOnly ? 'files' : ctxLines > 0 ? 'lines (incl. context)' : 'matches');
      if (lines.length > cap) {
        return `${lines.slice(0, cap).join('\n')}\n(showing the first ${cap} ${plural(cap)} — there are MORE; narrow the pattern, add include=, or use files_only=true to see the spread)`;
      }
      return `${lines.join('\n')}\n(${lines.length} ${plural(lines.length)})`;
    },
  };
