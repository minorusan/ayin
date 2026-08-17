/**
 * Explore tool — focused sub-investigation with its own LLM loop.
 *
 * Single-stage iteration:
 *   1. Build prompt with question + accumulated history (commands + results)
 *   2. LLM returns { reasoning, commands, confidence, answer }
 *   3. If answer or confidence >= threshold → return
 *   4. Execute commands, append results to history
 *   5. Loop
 *
 * Translates depth into width: each explore call is a focused mini-investigation
 * with clean context. Main agent calls explore many times to cover the tree.
 *
 * WHY IT LOOPED. `history` — the per-step reasoning + command + result log fed into the prompt — is
 * capped at 4 entries to keep the context small. From iteration 5 onward the model could no longer SEE
 * what it ran in steps 1-2, so it suggested them again, got the same answer again, and repeated until
 * `MAX_ITERATIONS` ran out. A 12-round loop with a 4-round memory repeats itself BY CONSTRUCTION — no
 * amount of "don't repeat yourself" in the prompt fixes an agent that has been made amnesiac about its
 * own recent past. Fixed with `spent` (below): every command ever run this investigation, in full, for
 * all 12 iterations, kept separately from the (still capped) narrative history. An exact repeat is
 * refused before a shell is even spawned, and two consecutive iterations of "every suggested command
 * was already spent" ends the investigation instead of running out the clock on refusals.
 *
 * "USELESS WITHOUT RAG ANYWAY." Correctly so, in one sense: this is a live, per-call grep/read
 * investigation with no persisted memory ACROSS calls — it rediscovers the codebase every single time
 * it runs. A per-project retrieval layer (embed once, recall across sessions) is a separate, much
 * larger project — a nightly indexing pass, project-scoped storage, retrieval wired into the agent's
 * context. It does not block this fix: an investigation that stops looping WITHIN itself is worth
 * having even before it can remember anything between calls, and would still be worth having after.
 */





import { toolLlm, toolLog, toolShell, toolReport, toolPrompts, type ToolPrompts } from './runtime.js';
import { NEVER_RECURSE } from './lib.js';

/**
 * This tool's prompt namespace — `prompts/explore/*.txt`, materialized into the operator's local
 * store at import time. INTERIM SHAPE: explore is still a plain function, not a `BaseTool`, so it
 * registers here at module scope instead of declaring `promptsSourceDir` and being handed a bundle
 * by the registry. The namespace boundary is already correct; when explore becomes a class the swap
 * is mechanical — `explorePrompts().get(...)` → `this.prompt(...)`.
 */
const explorePrompts = (): ToolPrompts => toolPrompts('explore');

const MAX_ITERATIONS = 12;
const COMMAND_TIMEOUT = 30_000;
/**
 * Context-expansion greps run AFTER the answer exists, so they get a fraction of the budget: a bonus
 * that can add minutes to a finished investigation is not a bonus.
 */
const EXPAND_TIMEOUT = 8_000;
/** How many commands one iteration may run. Exceeding it is REPORTED, never silently trimmed. */
const MAX_COMMANDS_PER_ITERATION = 2;
const MAX_COMMAND_OUTPUT = 8000;
const MAX_ANSWER_LENGTH = 8000;

/** Truncate at last sentence boundary before limit, not mid-sentence */
function capAnswer(text: string): string {
  if (text.length <= MAX_ANSWER_LENGTH) return text;
  // Find last sentence end (. or \n) before the limit
  const cut = Math.max(
    text.lastIndexOf('\n', MAX_ANSWER_LENGTH),
    text.lastIndexOf('. ', MAX_ANSWER_LENGTH),
    text.lastIndexOf(';\n', MAX_ANSWER_LENGTH),
    text.lastIndexOf('}\n', MAX_ANSWER_LENGTH),
  );
  if (cut > MAX_ANSWER_LENGTH * 0.5) return text.substring(0, cut + 1);
  return text.substring(0, MAX_ANSWER_LENGTH);
}

/**
 * Context expansion — after explore finds an answer, automatically grep for related code.
 * Extracts identifiers (functions, classes, types) from the answer text and greps for where
 * else they appear (callers, implementers, registrations). Pure grep — no LLM.
 * LANGUAGE-AGNOSTIC: searches all files (grep's own binary skip), not just one language.
 */
async function expandContext(answer: string, cwd: string): Promise<string> {
  // Extract candidate identifiers from the answer, language-neutrally:
  //  - camelCase / PascalCase words (functions, classes, types across C#, TS, JS, Go, Python…)
  //  - snake_case words (Python, Rust, C)
  // Then grep for each to surface related sites the model didn't think to ask for.
  const camel = answer.match(/\b[A-Za-z_][A-Za-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g) || []; // fooBar, FooBar, addMul
  const snake = answer.match(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g) || [];             // foo_bar, do_thing

  // Keep identifiers likely to be meaningful symbols; drop very short/common noise.
  const NOISE = new Set(['module', 'exports', 'require', 'const', 'return', 'function', 'export', 'import', 'default']);
  const allPatterns = [...new Set([...camel, ...snake])]
    .filter(p => p.length > 4 && p.length < 50 && !NOISE.has(p));
  if (allPatterns.length === 0) return '';

  const prioritized = allPatterns.slice(0, 8);

  // CONCURRENT, and on a SHORT leash. These run AFTER the answer is already in hand — they are a
  // bonus, not the result — and they used to run one after another on the 30s command timeout, so
  // eight identifiers could add four minutes to a finished investigation. Nothing here reads a
  // previous result, so there was never a reason to wait.
  const settled = await Promise.all(prioritized.map(async (pattern) => {
    try {
      // No --include filter: search every file type; grep -I skips binaries.
      // Vendor/build dirs are pruned with the SAME list the grep tool uses — two searches disagreeing
      // about what the repo contains is its own bug, and this list used to miss Unity's Library/,
      // which is gigabytes of import cache walked once per identifier.
      // The identifier is single-quoted: it comes from a regex over model prose, and an unquoted `$`
      // or backtick in a double-quoted shell string is code, not data.
      const prune = NEVER_RECURSE.map((d) => `--exclude-dir='${d}'`).join(' ');
      const { text: output } = await execCommand(
        `grep -rnIE ${prune} -- '${pattern.replace(/'/g, "'\\''")}' . 2>/dev/null | head -8`,
        cwd,
        EXPAND_TIMEOUT,
      );
      if (!output || output === '(no output)' || output.length <= 10) return '';
      const lines = output.split('\n')
        .filter(l => l.includes(':') && !l.includes('(no output)'))
        .slice(0, 5);
      return lines.length ? `"${pattern}" found in:\n${lines.join('\n')}` : '';
    } catch { return ''; } // one failed grep must not lose the other seven
  }));

  const results = settled.filter(Boolean);
  if (results.length === 0) return '';
  return results.join('\n\n');
}

interface CmdResult {
  text: string;
  timedOut: boolean;
  /** The command kept printing past what we were willing to hold. */
  overflowed: boolean;
}

/** Hard ceiling on what one command may buffer. `cat` of a large asset used to be held in full. */
const COMMAND_HARD_CAP = 64_000;

/**
 * Run one investigation command. Two rules that were missing and cost the investigation real evidence:
 *
 * A timeout used to `resolve('(timeout after 30s)')` — discarding everything the command had already
 * printed. A grep that ran 29 useful seconds over a large tree and then hit the wall returned NOTHING,
 * so the sub-agent concluded there was nothing there and moved on.
 *
 * And output accumulated without a ceiling, so one `cat` of a big file was buffered whole before being
 * trimmed for the prompt.
 */
function execCommand(command: string, cwd: string, timeoutMs = COMMAND_TIMEOUT): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = toolShell().spawn(command, { cwd });

    let stdout = '';
    let stderr = '';
    let overflowed = false;
    let done = false;

    const take = (buf: string, chunk: Buffer | string): string => {
      if (buf.length >= COMMAND_HARD_CAP) { overflowed = true; return buf; }
      const next = buf + chunk.toString();
      if (next.length > COMMAND_HARD_CAP) { overflowed = true; return next.slice(0, COMMAND_HARD_CAP); }
      return next;
    };
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout = take(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr = take(stderr, chunk); });

    const settle = (timedOut: boolean, fallback?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      resolve({ text: out || fallback || '(no output)', timedOut, overflowed });
    };

    const timer = setTimeout(() => {
      toolShell().kill(child);
      settle(true); // keep whatever it printed — partial evidence beats none
    }, timeoutMs);

    child.on('close', () => settle(false));
    child.on('error', () => settle(false, '(command failed to start)'));
  });
}

interface ExploreIteration {
  reasoning: string;
  commands: string[];
  confidence: number;
  answer?: string;
  /** Suggestions beyond the per-iteration cap. Reported to the model, never dropped in silence. */
  dropped?: number;
}

/**
 * A committed answer, or nothing.
 *
 * The main exit already required `length > 20` before treating a reply as the result; the three bail
 * paths returned `bestIteration.answer` with no such check, so a two-word non-answer could escape
 * through a timeout or a repeat-streak while the same text would have been rejected on the happy
 * path. One definition, used by every exit.
 */
function committedAnswer(it: ExploreIteration | null): string | undefined {
  const a = it?.answer?.trim();
  return a && a.length > 20 ? a : undefined;
}

interface HistoryEntry {
  reasoning: string;
  commands: string[];
  results: string[];
}

/** One command already run in this investigation: where, and whether it produced anything. */
interface SpentCommand {
  step: number;
  bytes: number;
}

/**
 * Commands are compared on their normalised text, so trivial whitespace differences do not read as a
 * new search. Deliberately NOT semantic: `grep -rn "foo" .` and `grep -nr "foo" .` are different
 * strings and both get to run once, because guessing that two shell commands are equivalent is how a
 * guard starts blocking legitimate work.
 */
export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ');
}

/**
 * The anti-repeat memory, rendered for the prompt.
 *
 * THIS IS THE FIX FOR THE REAL LOOP. `history` is capped at the last 4 steps to keep the context
 * small, so from iteration 5 onward the model could no longer SEE what it tried in steps 1-2 — and
 * duly suggested them again. A 12-iteration loop with a 4-step memory repeats itself by construction;
 * no amount of "please don't repeat" in the prompt can fix an agent that has been made amnesiac. So the
 * command list is kept in full, forever, separately from the (capped) result history, and every
 * iteration is told exactly what has already been spent.
 */
export function renderSpent(spent: Map<string, SpentCommand>): string {
  if (spent.size === 0) return '';
  const lines = [...spent.entries()].map(([cmd, s]) => `$ ${cmd}   → step ${s.step}, ${s.bytes > 0 ? `${s.bytes} bytes` : 'NOTHING'}`);
  return `\n\nCOMMANDS ALREADY RUN IN THIS INVESTIGATION — do NOT run any of these again; an identical `
    + `command is refused without executing, and one that returned NOTHING will return nothing again. `
    + `Search somewhere else or with a different pattern:\n${lines.join('\n')}`;
}

function buildPrompt(
  question: string,
  context: string,
  cwd: string,
  history: HistoryEntry[],
  spent: Map<string, SpentCommand>,
  iteration: number,
): string {
  const historyText = history.length === 0
    ? '(no previous steps)'
    : history.map((h, i) => {
        const cmdResults = h.commands.map((cmd, j) => `$ ${cmd}\n${h.results[j] || '(no output)'}`).join('\n\n');
        return `Step ${i + 1}: ${h.reasoning}\n${cmdResults}`;
      }).join('\n\n---\n\n');

  const remaining = MAX_ITERATIONS - iteration + 1;
  const pressureNote = remaining <= 3
    ? `\n${explorePrompts().get('timePressure', { REMAINING: String(remaining) })}`
    : '';

  const firstIterNote = iteration === 1
    ? `\n${explorePrompts().get('firstIteration')}`
    : '';

  const contextBlock = context
    ? `\n${explorePrompts().get('callerContext', { CONTEXT: context })}`
    : '';

  // Data-carrying vars are substituted LAST: `interpolate` rescans the whole string per key, so an
  // earlier-inserted value containing a later `{{VAR}}` would be expanded. Command output is the
  // biggest untrusted blob, so it goes in after everything else.
  return explorePrompts().get('investigate', {
    CWD: cwd,
    MAX_ITERATIONS: String(MAX_ITERATIONS),
    ITERATION: String(iteration),
    PRESSURE_NOTE: pressureNote,
    FIRST_ITER_NOTE: firstIterNote,
    QUESTION: question,
    CONTEXT_BLOCK: contextBlock,
    // The full-history anti-repeat memory rides in HISTORY, appended after the capped step log —
    // one placeholder, so no prompt file needs a new variable to get the fix.
    HISTORY: historyText + renderSpent(spent),
  });
}

/**
 * Fallback answer built from the actual command outputs gathered so far. Used when the model
 * found data but never committed it to the "answer" field (qwen sometimes stalls at low
 * confidence). Returns the real greps/reads so the caller gets usable data, not meta-reasoning.
 */
/**
 * Per-command budget in the digest. A bare `ls` of a project root is 380 entries of mode bits and
 * timestamps — measured filling the whole digest, and through it the caller's window, at the moment
 * the caller needed to hold two lines of C#. The digest exists to carry FINDINGS back; one command's
 * output must not be able to crowd out every other command's.
 */
const DIGEST_PER_COMMAND = 1200;

/** One command's real output, kept for the whole investigation. See `Findings` below. */
export interface Finding { cmd: string; out: string }

/** Total digest budget. Bounded so the fallback answer cannot itself blow the caller's window. */
const DIGEST_TOTAL = 6000;

/**
 * The findings digest — every command's REAL output, for the whole investigation.
 *
 * IT USED TO READ `history`, WHICH FORGETS. `history` is capped at 4 steps for context size, so on a
 * 12-iteration investigation the digest — the thing returned when the model never commits an answer —
 * contained only the last four steps. A grep that struck gold at iteration 2 was gone by the time the
 * fallback ran. That is the same amnesia this file's header describes fixing for REPEATS (with
 * `spent`); the digest was still reading the forgetful record.
 *
 * `Findings` is accumulated separately and never shrinks, exactly like `spent`.
 *
 * RANKED, because a digest is evidence and not a transcript. Output carrying `path:line:` is a
 * located fact; a bare directory listing is not, and one `ls -la` of a project root was measured
 * filling the digest at the moment the caller needed two lines of C#. File:line chunks go first, and
 * the budget is spent on them.
 */
function digestFrom(findings: readonly Finding[]): string {
  const scored = findings.map((f) => ({
    ...f,
    // A line like `src/x.ts:42:` — the shape of a located fact.
    hits: (f.out.match(/^[^\s:]+:\d+:/gm) ?? []).length,
  }));
  scored.sort((a, b) => (b.hits > 0 ? 1 : 0) - (a.hits > 0 ? 1 : 0));

  const chunks: string[] = [];
  let spentChars = 0;
  for (const f of scored) {
    if (spentChars >= DIGEST_TOTAL) break;
    const room = Math.min(DIGEST_PER_COMMAND, DIGEST_TOTAL - spentChars);
    const clipped = f.out.length > room
      ? `${f.out.slice(0, room)}\n…(+${f.out.length - room} chars from this command)`
      : f.out;
    chunks.push(`$ ${f.cmd}\n${clipped}`);
    spentChars += clipped.length;
  }
  return chunks.join('\n\n');
}

/**
 * Pull the `answer` out of a reply whose JSON did not parse — usually because generation was cut off
 * mid-object.
 *
 * THIS IS WHERE A REAL ANSWER WAS LOST. Measured: explore located the bug on its second iteration and
 * put it in `answer` — the file, the line, the expression. The reply was truncated, `JSON.parse`
 * threw, and the whole raw object was handed back to the caller as if the BLOB were the finding. The
 * agent read a wrapper whose `reasoning` and `commands` fields said "still searching", concluded
 * explore had nothing, and went on to spend six more steps rediscovering it.
 *
 * So a malformed reply is mined for the one field worth having before anything is discarded. Scans
 * the raw string rather than repairing the JSON: a truncated object cannot be parsed by definition,
 * and the value is readable long before the object is closed.
 */
export function salvageAnswer(raw: string): string | undefined {
  const key = /"answer"\s*:\s*"/.exec(raw);
  if (!key) return undefined;
  let out = '';
  for (let i = key.index + key[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') {
      const next = raw[i + 1];
      if (next === undefined) break;                       // truncated mid-escape — keep what we have
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '' : next;
      i++;
      continue;
    }
    if (c === '"') break;                                   // the string closed properly
    out += c;
  }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseResponse(raw: string): ExploreIteration {
  let cleaned = raw.trim();



  // Strip markdown fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  }

  // Find first { and last }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.substring(start, end + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      reasoning: String(parsed.reasoning || ''),
      commands: Array.isArray(parsed.commands) ? parsed.commands.slice(0, MAX_COMMANDS_PER_ITERATION).map(String) : [],
      // How many were DROPPED, so the loop can say so. Trimming four suggestions to two in silence
      // meant the model proposed the other two again next iteration — they were never run, so `spent`
      // did not know them — which is a slow-motion version of the loop `spent` exists to stop.
      dropped: Array.isArray(parsed.commands) ? Math.max(0, parsed.commands.length - MAX_COMMANDS_PER_ITERATION) : 0,
      confidence: parseFloat(parsed.confidence) || 0,
      answer: parsed.answer && parsed.answer !== null ? String(parsed.answer) : undefined,
    };
  } catch {
    // A malformed reply is usually a TRUNCATED one, and the `answer` it was part-way through writing
    // is the whole point of the call. Mine it out before discarding anything.
    const salvaged = salvageAnswer(cleaned);
    if (salvaged) {
      return { reasoning: 'Recovered the answer from a truncated JSON reply', commands: [], confidence: 0.5, answer: salvaged };
    }
    // NOTHING SALVAGEABLE → this is not an answer, and must not be returned as one. Handing the raw
    // object back as `answer` is what made a wrapper look like a finding: the caller cannot tell a
    // result from the model's scratchpad, and a plausible non-answer costs more than an honest miss.
    return {
      reasoning: 'Failed to parse JSON response',
      commands: [],
      confidence: 0,
      answer: undefined,
    };
  }
}

/**
 * Read-only commands an investigation may run. DELIBERATELY SHORT.
 *
 * Everything tempting to add here can write or spawn: `awk` has `system()`, `sed` has `w`, `sort` has
 * `-o`, `uniq` takes an output file as its second operand. A tool earns a place on this list by being
 * unable to change anything, not by being useful.
 */
const ALLOWED_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'grep', 'find',
  'git show', 'git log', 'git blame', 'git branch', 'git grep',
  'wc', 'echo', 'cut', 'tr',
];

/**
 * Flags that turn a listed READ command into a write or an exec.
 *
 * `find` is the one that matters: `find . -delete` and `find . -exec rm {} +` both pass any prefix
 * check and both destroy files. Found by writing the test, not by reading the code.
 */
const DANGEROUS_FLAGS = /(^|\s)-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf|fprint0)(\s|$)/;

/**
 * Shell syntax that turns one command into two, or into a write.
 *
 * `$(…)` and backticks run a nested command; `>`/`>>` create or truncate a file; `<(…)` is process
 * substitution; `&` backgrounds. None of these belong in a read-only investigation, and every one of
 * them defeats a prefix check.
 */
const SHELL_ESCAPES = /\$\(|`|>|<\(|&(?!&)/;

/**
 * Split a command on its pipeline operators, IGNORING anything inside quotes.
 *
 * A plain `split(/\|\||&&|;|\|/)` looks right and silently broke the most useful search there is:
 * `grep -rnE "time bonus|bonus.*time" .` splits inside the REGEX, the second half becomes
 * `bonus.*time" .`, that starts with no allowed prefix, and the command is refused. Alternation is
 * exactly what ayin's own grep description tells the model to use ("alternation (a|b), ?, +, () all
 * work"), so explore lost its best tool and fell back to `ls` — measured as a 3m14s investigation
 * that returned a directory listing as its finding.
 *
 * Quote tracking is what makes the guarantee survive the fix: a `;` INSIDE quotes is data being
 * handed to grep as a pattern, while a `;` outside them starts a second command and must still be
 * refused.
 */
function splitPipeline(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote && cmd[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === '\'') { quote = c; cur += c; continue; }
    if (c === ';') { out.push(cur); cur = ''; continue; }
    if (c === '|') { if (cmd[i + 1] === '|') i++; out.push(cur); cur = ''; continue; }
    if (c === '&' && cmd[i + 1] === '&') { i++; out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * The command with quoted spans blanked out — what the escape and flag checks must read.
 *
 * `grep -rn "a > b" .` contains a `>` that redirects nothing; refusing it is the same false positive
 * as the pipeline one above. Blanking rather than removing keeps offsets sane for anything that
 * later wants them.
 */
function unquotedSkeleton(cmd: string): string {
  let out = '';
  let quote: '"' | '\'' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      out += c === quote && cmd[i - 1] !== '\\' ? (quote = null, c) : ' ';
      continue;
    }
    if (c === '"' || c === '\'') { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

/**
 * May this model-authored command run?
 *
 * THIS USED TO BE `trimmed.startsWith(prefix)` — a prefix test on a string that is then handed to
 * `sh -lc`, which is not a check at all. Verified: `grep foo . ; echo INJECTED` passed, and the
 * second command ran. `cat /etc/hostname | tee /tmp/x` passed. The list read like a sandbox and
 * enforced nothing.
 *
 * That matters more here than in most places, because explore is the ONE tool whose inner commands
 * never reach `checkPermission`: the agent loop gates `bash` per command, but it only ever sees
 * `explore(question, context)`. So approving explore once approved every command it would ever
 * invent — in headless, silently.
 *
 * The fix is to make the allow-list TRUE rather than to bolt a prompt onto a sub-loop. A pipeline is
 * still allowed, because `grep -rn foo . | head -20` is exactly what an investigation should do — but
 * EVERY segment must independently start with a read-only command, and anything that can spawn a
 * nested command or write a file is refused outright.
 *
 * Deliberately not a permission prompt: explore runs many commands per investigation, and a gate that
 * asks twelve times is a gate the operator turns off. Confinement beats consent here. If explore ever
 * needs to MUTATE something, that is the point at which it must go through `checkPermission`.
 */
export function isAllowed(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  // Checked against the skeleton, so a `>` or a `$(` that is plainly INSIDE a quoted search pattern
  // is read as the data it is. Anything outside quotes is still refused outright.
  const bare = unquotedSkeleton(trimmed);
  if (SHELL_ESCAPES.test(bare)) return false;
  if (DANGEROUS_FLAGS.test(bare)) return false;
  const segments = splitPipeline(trimmed);
  return segments.every((seg) => {
    const s = seg.trim();
    if (!s) return false;
    return ALLOWED_PREFIXES.some((prefix) => s === prefix || s.startsWith(`${prefix} `));
  });
}

export async function exploreExecute(params: Record<string, string>): Promise<string> {
  const question = params.question;
  const context = params.context || '';
  // Every command and the context expansion run here. Defaults to the process cwd — which is what
  // the agent loop wants, since the operator's session IS the repo. `indulge` investigates a repo
  // named by `--repoPath` instead, and passing it here is what keeps that from becoming a
  // `process.chdir()`: a global mutation for a per-call fact.
  const cwd = params.cwd || process.cwd();
  // thorough: let the investigation run long before the digest-commit guard
  // may cut it — broad "how does X work" questions legitimately need many read steps.
  const digestCommitAt = params.thorough === 'true' ? 9 : 4;

  if (!question) return 'Error: question required';

  toolLog().info('explore_start', { question: question.substring(0, 100) });
  toolReport(`Exploring: ${question.substring(0, 80)}...`);

  const history: HistoryEntry[] = [];
  // THE ACTUAL LOOP FIX. `history` is capped at 4 steps for context size, so from iteration 5 onward
  // the model could no longer see what it ran in steps 1-2 and duly suggested them again — a
  // 12-iteration loop with 4-step memory repeats by construction. `spent` never forgets: every command
  // ever run this investigation, keyed by its normalised text, for the FULL 12 iterations.
  const spent = new Map<string, SpentCommand>();
  // Every command's REAL output, for the whole investigation — never trimmed like `history` is, for
  // the same reason `spent` isn't: the fallback digest is built from this, and a digest assembled
  // from a 4-step window silently drops whatever the first eight iterations found. See digestFrom().
  const findings: Finding[] = [];
  let bestIteration: ExploreIteration | null = null;
  let emptyStreak = 0; // consecutive iterations where every command returned nothing → bail early
  let repeatStreak = 0; // consecutive iterations where EVERY suggested command was already spent

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const prompt = buildPrompt(question, context, cwd, history, spent, i + 1);

    let response: string;
    try {
      response = await toolLlm().ask([
        { role: 'system', content: explorePrompts().get('investigatorSystem') },
        { role: 'user', content: prompt },
      ]);
    } catch (err) {
      toolLog().error('explore_llm_error', { error: String(err), iteration: String(i + 1) });
      if (bestIteration) return bestIteration.answer || bestIteration.reasoning;
      return history.length > 0
        ? `Investigation interrupted at iteration ${i + 1}. Last finding: ${history[history.length - 1].reasoning}`
        : 'Investigation failed: LLM error';
    }

    const iteration = parseResponse(response);
    toolReport(`  [${i + 1}] ${iteration.reasoning.substring(0, 100)} (${Math.round(iteration.confidence * 100)}%)`);

    // HARD RULE: iteration 1 cannot return an answer. Force the model to run commands first.
    // This catches hallucination (model making up git log output from memory)
    // and refusal (model saying "I cannot execute commands").
    if (i === 0 && iteration.answer) {
      toolLog().warn('explore_iter1_answer_rejected', { preview: iteration.answer.substring(0, 80) });
      iteration.answer = undefined;
      // If it also didn't provide commands, inject a language-agnostic starter.
      if (iteration.commands.length === 0) {
        iteration.commands = [`ls`];  // see what's here, whatever the language
      }
    }

    // Track best iteration by confidence
    if (!bestIteration || (iteration.answer && !bestIteration.answer) ||
        (!!iteration.answer === !!bestIteration.answer && iteration.confidence > bestIteration.confidence)) {
      bestIteration = iteration;
    }

    // Terminal: model provided an answer (allowed after iteration 1)
    if (iteration.answer && iteration.answer.length > 20) {
      let answer = capAnswer(iteration.answer);

      // Context expansion — automatically find related code based on identifiers in the answer.
      // This is pure grep, no LLM. Catches the files the model wouldn't think to ask for.
      // Returns expansion separately so it can be added as a distinct fact, not buried in the answer.
      const expanded = await expandContext(answer, cwd);
      if (expanded) {
        toolReport(`  → related code found:\n${expanded.substring(0, 500)}`);
        // Return expansion as a clearly separated section
        answer += `\n\nRELATED (auto-discovered — these files also interact with the code above):\n${expanded}`;
      }

      toolLog().info('explore_done', { iterations: String(i + 1), confidence: String(iteration.confidence), reason: 'answer', answerPreview: answer.substring(0, 300) });
      toolReport(`  → answer: ${answer.substring(0, 200)}`);
      return capAnswer(answer);
    }

    // No commands and no answer — the model stalled. Return the real data we already gathered
    // (grep/read outputs) rather than the model's meta-reasoning, which is useless to the caller.
    if (iteration.commands.length === 0) {
      toolLog().warn('explore_stuck', { iteration: String(i + 1) });
      const digest = digestFrom(findings);
      if (digest) return capAnswer(`Found (from the searches run so far):\n\n${digest}`);
      return iteration.reasoning || 'Investigation inconclusive: no commands suggested.';
    }

    // Execute commands. An EXACT repeat of something already run this investigation is refused
    // WITHOUT spawning a shell — re-running `grep -rn foo .` a fourth time costs a process and 30s of
    // timeout budget to learn nothing the model wasn't already told in `spent`.
    const results: string[] = [];
    // NO SILENT CAPS. Extra suggestions are refused out loud, so the model knows to re-propose the
    // one it cares about rather than assuming all four ran.
    if (iteration.dropped) {
      results.push(`(only the first ${MAX_COMMANDS_PER_ITERATION} commands were run — ${iteration.dropped} more were NOT. Re-suggest the one you still need.)`);
      toolLog().info('explore_commands_capped', { dropped: String(iteration.dropped), iter: String(i + 1) });
    }
    let anyData = false;
    let anyNewCommand = false;
    for (const cmd of iteration.commands) {
      const key = normalizeCommand(cmd);
      const already = spent.get(key);
      if (already) {
        results.push(`(already run at step ${already.step}, ${already.bytes > 0 ? `${already.bytes} bytes` : 'NOTHING'} — refused, not re-run)`);
        continue;
      }
      anyNewCommand = true;
      if (!isAllowed(cmd)) {
        results.push(`(blocked: ${cmd.substring(0, 50)} not in allowed list)`);
        spent.set(key, { step: i + 1, bytes: 0 });
        continue;
      }
      const res = await execCommand(cmd, cwd);
      const output = res.text;
      const empty = !output || output === '(no output)' || output === '(command failed to start)' || output.trim().length === 0;
      if (!empty) anyData = true;
      spent.set(key, { step: i + 1, bytes: empty ? 0 : output.length });
      toolLog().info('explore_cmd', { iter: String(i + 1), cmd: cmd.substring(0, 120), bytes: String(output.length), empty: String(empty), timedOut: String(res.timedOut) });
      let trimmed = output;
      // Every cut is announced. A silently shortened grep reads as the complete answer, and the
      // sub-agent then reports "X appears in 3 places" when it was shown 3 of 300.
      if (output.length > MAX_COMMAND_OUTPUT) {
        const cut = output.lastIndexOf('\n', MAX_COMMAND_OUTPUT);
        trimmed = cut > MAX_COMMAND_OUTPUT * 0.5
          ? output.substring(0, cut)
          : output.substring(0, MAX_COMMAND_OUTPUT);
        trimmed += `\n… [cut at ${MAX_COMMAND_OUTPUT} chars — this is PART of the output. Narrow the command (a tighter pattern, --include, head) to see the rest.]`;
      }
      if (res.overflowed) trimmed += `\n[the command kept printing beyond what was collected — it produced more than shown]`;
      if (res.timedOut) {
        trimmed += `\n[TIMED OUT after ${COMMAND_TIMEOUT / 1000}s and was killed: this output is PARTIAL and the search never finished. Narrow the path or the pattern and run it again.]`;
      }
      results.push(trimmed);
      // Kept for the digest even after `history` forgets this step.
      if (!empty) findings.push({ cmd, out: trimmed });
    }

    // Repeat-guard: every suggested command was something already spent — the model is circling with
    // nothing new to try. Without this it would run the loop out on refusals that cost zero shell
    // calls but still burn LLM rounds, which is a slower version of the same loop.
    repeatStreak = anyNewCommand ? 0 : repeatStreak + 1;
    if (repeatStreak >= 2) {
      toolLog().warn('explore_repeat_streak_bail', { iteration: String(i + 1) });
      toolReport(`  → explore: circling on commands already run, stopping.`);
      const digest = digestFrom(findings);
      // SAY WHY IT STOPPED, not just what it found. The digest used to carry the "(already run…)"
      // refusal lines by accident — it was assembled from the narrative history, which recorded them
      // — so the reason survived as a side effect. Now the digest is real evidence only, and the
      // reason has to be stated deliberately: a caller handed partial findings with no explanation
      // reads them as the complete answer.
      return committedAnswer(bestIteration)
        || (digest && capAnswer(`Stopped after ${i + 1} rounds: circling on searches already run.\nFound so far:\n\n${digest}`))
        || `Explore is circling on the same searches for: "${question}" — stopped after ${i + 1} rounds. What was already run: ${[...spent.keys()].slice(0, 8).join('; ')}`;
    }

    // Stuck-guard: if commands keep returning nothing, don't burn all 12 iterations.
    emptyStreak = anyData ? 0 : emptyStreak + 1;
    if (emptyStreak >= 3) {
      toolLog().warn('explore_empty_streak_bail', { iteration: String(i + 1) });
      toolReport(`  → explore: 3 empty searches in a row, stopping. Try a broader question or check the path.`);
      const digest = digestFrom(findings);
      return committedAnswer(bestIteration)
        || (digest && capAnswer(`Stopped after ${i + 1} rounds: three searches in a row returned nothing.\nFound so far:\n\n${digest}`))
        || `Explore could not find anything for: "${question}". Searched ${i + 1} times, all commands returned no data. The symbol/file may not exist here, or the working directory (${cwd}) may be wrong.`;
    }

    history.push({
      reasoning: iteration.reasoning,
      commands: iteration.commands,
      results,
    });

    // Found-but-won't-commit guard: qwen often keeps re-searching at low confidence even after its
    // commands returned the answer. Once we have substantial gathered data and the model is STILL
    // reporting low confidence a few iterations in, stop and return the real data rather than
    // looping to 12. Confidence-gated so a legitimately progressing investigation (rising
    // confidence, about to commit an answer) is not cut off at iteration 4.
    if (i + 1 >= digestCommitAt && iteration.confidence < 0.6) {
      const digest = digestFrom(findings);
      if (digest.length > 200) {
        toolLog().info('explore_commit_digest', { iteration: String(i + 1), bytes: String(digest.length) });
        toolReport(`  → have data, committing it (model kept re-searching)`);
        return capAnswer(`Found (from the searches run):\n\n${digest}`);
      }
    }

    // Cap history at last 4 steps to keep context manageable
    if (history.length > 4) {
      history.shift();
    }
  }

  // Max iterations reached — prefer a committed answer, else the real command data gathered.
  toolLog().warn('explore_max_iterations', { bestConfidence: String(bestIteration?.confidence ?? 0) });
  const committed = committedAnswer(bestIteration);
  if (committed) return capAnswer(committed);
  const digest = digestFrom(findings);
  if (digest) return capAnswer(`Found (from the searches run so far):\n\n${digest}`);
  return capAnswer(bestIteration?.reasoning || 'Reached max iterations with no findings.');
}
