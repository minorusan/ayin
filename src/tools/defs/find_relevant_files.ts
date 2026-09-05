import { existsSync, statSync } from 'node:fs';
import { BaseTool, type RunContext } from '../base.js';
import { resolveAgainstCwd } from '../lib.js';
import { toolLog, toolSubagent } from '../runtime.js';

/**
 * `find_relevant_files` — "which files does this task touch?", answered by an agent that can look.
 *
 * WHY NOT `explore`. `explore` is deterministic localization: terms in, ranked spans out, ~400 ms, no
 * model (see `tools/explore/index.ts` for why it was de-agenticised). It is excellent at *"where is
 * `ScoringId` mentioned"* and blind to *"which files would I have to change to add a retry to the
 * uploader"* — a question that needs someone to read what it finds and judge. So this delegates to a
 * SUBAGENT, which has explore, grep, bash and read_file, and whose whole job is to come back with a
 * list.
 *
 * THE FORMAT IS THE CONTRACT, AND IT IS CHECKED. The child is told to answer in one strict shape, and
 * what it returns is parsed here and every path VERIFIED against the filesystem. A file it invented is
 * dropped and reported as invented — because a confident list of paths that do not exist is worse than
 * no list: the caller acts on it, and the first failure looks like an unrelated bug three tools later.
 *
 * IT NEVER RETURNS PROSE. The caller asked for files. A subagent that answers with a paragraph gets its
 * paragraph discarded and the caller is told plainly that the search produced nothing usable.
 *
 * IT TAKES `ctx`, AND THAT IS NOT COSMETIC. Delegating to a child means a PROCESS that runs for
 * minutes, and `subagents.ts` gives it no timeout on purpose — "a clock cannot tell a subagent that is
 * thinking from one that is stuck — only the signal can". Passing the signal is therefore this tool's
 * obligation, not an optional courtesy: without it there is no timeout AND no cancellation, so Esc
 * cannot reach the child and nothing in the system can end the run except the child finishing.
 * Without `onStatus` the card is blank for the whole of it, which is indistinguishable from a hang and
 * invites the operator to kill the session — the exact symptom `defs/subagent.ts` was fixed for
 * ("5m30s of a blank card"), which this tool did not inherit because the runtime port had nowhere to
 * carry the two fields.
 *
 * IT IS ALSO THE SLOWEST TOOL HERE, and honestly so: a child inherits the parent's provider unless
 * `/set-subagent-model` says otherwise, and on a self-hosted card the model is one QUEUE — parent and
 * child take turns for every round. Pointing children at a hosted model is what makes this tool quick;
 * the narration below is what makes it bearable when they are not.
 */
class FindRelevantFiles extends BaseTool {
  readonly name = 'find_relevant_files';
  readonly icon = '🗂️';
  readonly description =
    'Ask which files a task would touch, and get back a verified list with a note on each. Hand it the '
    + 'task in plain words — "add a retry to the uploader", "where does the session id get set" — and an '
    + 'agent with search tools reads the tree and reports the files that matter and why. Every path it '
    + 'names is checked to exist before you see it. Use this before editing when you do not already know '
    + 'which files are involved.';

  readonly parameters = [
    {
      name: 'task',
      type: 'string',
      description: 'What you are trying to do, in plain words. The more concrete, the better the list.',
      required: true,
    },
    { name: 'cwd', type: 'string', description: 'Directory to search in. Defaults to the current one.', required: false },
  ];

  async execute(params: Record<string, string>, ctx?: RunContext): Promise<string> {
    const task = String(params.task ?? '').trim();
    if (!task) return 'Error: task required';
    const cwd = params.cwd ? resolveAgainstCwd(String(params.cwd)) : process.cwd();

    // The format is stated to the child in the same words it is parsed by, immediately below — one
    // place to change, so the parser and the instruction cannot drift apart.
    const brief = `${task}

Find every file that this task would need to read or change. Use explore, grep and read_file — read
enough of each candidate to be sure it is relevant, not just that it matched a word.

Answer with ONLY lines in this exact shape, one per file, and nothing else — no preamble, no summary:

FILE: <path relative to ${cwd}> | <one line saying why this file matters to the task>

Paths must be real files that exist. Do not guess, do not list a file you have not confirmed, and do
not list directories. If nothing is relevant, answer with the single word NONE.`;

    // Said BEFORE the spawn, because the first thing the operator needs to know is that a child is
    // starting at all — the gap between the call and the child's first line of output is itself long
    // enough to read as nothing happening.
    ctx?.onStatus(`delegating to a search agent in ${cwd} → it will read candidates before naming them`);
    const result = await toolSubagent()(brief, {
      cwd,
      // The two fields this tool could not pass until the runtime port was widened. See the header.
      signal: ctx?.signal,
      onStatus: ctx?.onStatus,
    });
    ctx?.onStatus(result.ok
      ? `search agent finished — ${result.toolCalls} tool call(s) → verifying every path it named`
      : `search agent FAILED after ${result.toolCalls} tool call(s) → reporting what came back`);

    const parsed = parseFileReport(result.report, cwd);

    ctx?.onStatus(`${parsed.files.length} file(s) verified on disk`
      + `${parsed.invented.length ? `, ${parsed.invented.length} invented and dropped` : ''}`);

    toolLog().info('find_relevant_files', {
      task: task.slice(0, 120),
      found: String(parsed.files.length),
      invented: String(parsed.invented.length),
      toolCalls: String(result.toolCalls),
    });

    if (parsed.none) return `No files are relevant to "${task}" — the search agent looked and found nothing.`;
    if (parsed.files.length === 0) {
      return `find_relevant_files produced NO USABLE LIST for "${task}" (the agent made ${result.toolCalls} tool call(s) `
        + 'and answered in prose rather than the required format). Nothing here is verified — search yourself '
        + 'rather than acting on a guess.';
    }

    const lines = parsed.files.map((f) => `- ${f.path} — ${f.why}`);
    const warn = parsed.invented.length
      ? `\n\nDROPPED (the agent named these, they do not exist): ${parsed.invented.join(', ')}`
      : '';
    return `Files relevant to "${task}" (${parsed.files.length} verified, from ${result.toolCalls} tool call(s)):\n\n`
      + `${lines.join('\n')}${warn}`;
  }
}

export interface FileReport {
  files: Array<{ path: string; why: string }>;
  /** Paths the agent named that are not files on disk. Reported, never silently dropped. */
  invented: string[];
  none: boolean;
}

/** Parse the strict format, and verify every path. Deterministic — no model, no network. */
export function parseFileReport(report: string, cwd: string): FileReport {
  const out: FileReport = { files: [], invented: [], none: false };
  if (/^\s*NONE\s*$/im.test(report) && !/^\s*FILE:/im.test(report)) {
    out.none = true;
    return out;
  }
  const seen = new Set<string>();
  for (const line of report.split('\n')) {
    const m = /^\s*FILE:\s*(.+?)\s*\|\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const path = m[1].replace(/^["'`]|["'`]$/g, '').trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const full = path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`;
    // A DIRECTORY IS NOT AN ANSWER either — the caller asked which files, and "src/" is the question
    // restated.
    if (existsSync(full) && statSync(full).isFile()) out.files.push({ path, why: m[2].trim() });
    else out.invented.push(path);
  }
  return out;
}

export const tool = new FindRelevantFiles();
