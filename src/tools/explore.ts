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

  const results: string[] = [];
  for (const pattern of prioritized) {
    try {
      // No --include filter: search every file type; grep -I skips binaries.
      // But DO skip vendor/build dirs — on a JS/Rust/Python repo they'd drown the 8-line
      // budget in third-party matches and can stall a big tree toward the 30s timeout.
      // The identifier is single-quoted: it comes from a regex over model prose, and an unquoted `$`
      // or backtick in a double-quoted shell string is code, not data.
      const { text: output } = await execCommand(
        `grep -rnIE --exclude-dir={.git,node_modules,'dist*','*.bak*',build,vendor,target,.venv,__pycache__} -- '${pattern.replace(/'/g, "'\\''")}' . 2>/dev/null | head -8`,
        cwd,
      );
      if (output && output !== '(no output)' && output.length > 10) {
        // Filter to just file:line entries, skip the file we already found
        const lines = output.split('\n')
          .filter(l => l.includes(':') && !l.includes('(no output)'))
          .slice(0, 5);
        if (lines.length > 0) {
          results.push(`"${pattern}" found in:\n${lines.join('\n')}`);
        }
      }
    } catch { /* skip failed greps */ }
  }

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
function execCommand(command: string, cwd: string): Promise<CmdResult> {
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
    }, COMMAND_TIMEOUT);

    child.on('close', () => settle(false));
    child.on('error', () => settle(false, '(command failed to start)'));
  });
}

interface ExploreIteration {
  reasoning: string;
  commands: string[];
  confidence: number;
  answer?: string;
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
function historyDigest(history: HistoryEntry[]): string {
  const chunks: string[] = [];
  for (const h of history) {
    for (let j = 0; j < h.commands.length; j++) {
      const out = (h.results[j] || '').trim();
      if (out && out !== '(no output)' && out.length > 3) {
        chunks.push(`$ ${h.commands[j]}\n${out}`);
      }
    }
  }
  return chunks.join('\n\n');
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
      commands: Array.isArray(parsed.commands) ? parsed.commands.slice(0, 2).map(String) : [],
      confidence: parseFloat(parsed.confidence) || 0,
      answer: parsed.answer && parsed.answer !== null ? String(parsed.answer) : undefined,
    };
  } catch {
    // If JSON parse fails, treat whole response as a stuck/abort signal
    return {
      reasoning: 'Failed to parse JSON response',
      commands: [],
      confidence: 0,
      answer: cleaned.length > 0 ? cleaned : undefined,
    };
  }
}

const ALLOWED_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'grep', 'find',
  'git show', 'git log', 'git blame', 'git branch', 'git grep',
  'wc', 'echo',
];

function isAllowed(cmd: string): boolean {
  const trimmed = cmd.trim();
  return ALLOWED_PREFIXES.some(prefix => trimmed.startsWith(prefix));
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
      const digest = historyDigest(history);
      if (digest) return capAnswer(`Found (from the searches run so far):\n\n${digest}`);
      return iteration.reasoning || 'Investigation inconclusive: no commands suggested.';
    }

    // Execute commands. An EXACT repeat of something already run this investigation is refused
    // WITHOUT spawning a shell — re-running `grep -rn foo .` a fourth time costs a process and 30s of
    // timeout budget to learn nothing the model wasn't already told in `spent`.
    const results: string[] = [];
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
    }

    // Repeat-guard: every suggested command was something already spent — the model is circling with
    // nothing new to try. Without this it would run the loop out on refusals that cost zero shell
    // calls but still burn LLM rounds, which is a slower version of the same loop.
    repeatStreak = anyNewCommand ? 0 : repeatStreak + 1;
    if (repeatStreak >= 2) {
      toolLog().warn('explore_repeat_streak_bail', { iteration: String(i + 1) });
      toolReport(`  → explore: circling on commands already run, stopping.`);
      const digest = historyDigest(history);
      return bestIteration?.answer
        || (digest && capAnswer(`Found (from the searches run so far):\n\n${digest}`))
        || `Explore is circling on the same searches for: "${question}" — stopped after ${i + 1} rounds. What was found: ${[...spent.keys()].slice(0, 8).join('; ')}`;
    }

    // Stuck-guard: if commands keep returning nothing, don't burn all 12 iterations.
    emptyStreak = anyData ? 0 : emptyStreak + 1;
    if (emptyStreak >= 3) {
      toolLog().warn('explore_empty_streak_bail', { iteration: String(i + 1) });
      toolReport(`  → explore: 3 empty searches in a row, stopping. Try a broader question or check the path.`);
      const digest = historyDigest(history);
      return bestIteration?.answer
        || (digest && capAnswer(`Found (from the searches run so far):\n\n${digest}`))
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
      const digest = historyDigest(history);
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
  if (bestIteration?.answer) return capAnswer(bestIteration.answer);
  const digest = historyDigest(history);
  if (digest) return capAnswer(`Found (from the searches run so far):\n\n${digest}`);
  return capAnswer(bestIteration?.reasoning || 'Reached max iterations with no findings.');
}
