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
 */

import { llmChat } from '../llm/manager.js';
import { spawnShell, killTree } from '../shell.js';
import { log } from '../log.js';
import { addMessage } from '../ui.js';
import { prompts, packagePath } from '../prompts-service.js';

/**
 * This tool's prompt namespace — `prompts/explore/*.txt`, materialized into the operator's local
 * store at import time. INTERIM SHAPE: explore is still a plain function, not a `BaseTool`, so it
 * registers here at module scope instead of declaring `promptsSourceDir` and being handed a bundle
 * by the registry. The namespace boundary is already correct; when explore becomes a class the swap
 * is mechanical — `explorePrompts.get(...)` → `this.prompt(...)`.
 */
const explorePrompts = prompts.register('explore', packagePath('prompts', 'explore')).bundle;

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
      const output = await execCommand(
        `grep -rnI --exclude-dir={.git,node_modules,'dist*','*.bak*',build,vendor,target,.venv,__pycache__} "${pattern}" . 2>/dev/null | head -8`,
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

function execCommand(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawnShell(command, { cwd });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      killTree(child);
      resolve('(timeout after 30s)');
    }, COMMAND_TIMEOUT);

    child.on('close', () => {
      clearTimeout(timer);
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      resolve(out || '(no output)');
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve('(command failed to start)');
    });
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

function buildPrompt(
  question: string,
  context: string,
  cwd: string,
  history: HistoryEntry[],
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
    ? `\n${explorePrompts.get('timePressure', { REMAINING: String(remaining) })}`
    : '';

  const firstIterNote = iteration === 1
    ? `\n${explorePrompts.get('firstIteration')}`
    : '';

  const contextBlock = context
    ? `\n${explorePrompts.get('callerContext', { CONTEXT: context })}`
    : '';

  // Data-carrying vars are substituted LAST: `interpolate` rescans the whole string per key, so an
  // earlier-inserted value containing a later `{{VAR}}` would be expanded. Command output is the
  // biggest untrusted blob, so it goes in after everything else.
  return explorePrompts.get('investigate', {
    CWD: cwd,
    MAX_ITERATIONS: String(MAX_ITERATIONS),
    ITERATION: String(iteration),
    PRESSURE_NOTE: pressureNote,
    FIRST_ITER_NOTE: firstIterNote,
    QUESTION: question,
    CONTEXT_BLOCK: contextBlock,
    HISTORY: historyText,
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
  const cwd = process.cwd();
  // thorough: let the investigation run long before the digest-commit guard
  // may cut it — broad "how does X work" questions legitimately need many read steps.
  const digestCommitAt = params.thorough === 'true' ? 9 : 4;

  if (!question) return 'Error: question required';

  log('INFO', 'explore_start', { question: question.substring(0, 100) });
  addMessage('system', `Exploring: ${question.substring(0, 80)}...`);

  const history: HistoryEntry[] = [];
  let bestIteration: ExploreIteration | null = null;
  let emptyStreak = 0; // consecutive iterations where every command returned nothing → bail early

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const prompt = buildPrompt(question, context, cwd, history, i + 1);

    let response: string;
    try {
      response = await llmChat([
        { role: 'system', content: explorePrompts.get('investigatorSystem') },
        { role: 'user', content: prompt },
      ]);
    } catch (err) {
      log('ERROR', 'explore_llm_error', { error: String(err), iteration: String(i + 1) });
      if (bestIteration) return bestIteration.answer || bestIteration.reasoning;
      return history.length > 0
        ? `Investigation interrupted at iteration ${i + 1}. Last finding: ${history[history.length - 1].reasoning}`
        : 'Investigation failed: LLM error';
    }

    const iteration = parseResponse(response);
    addMessage('system', `  [${i + 1}] ${iteration.reasoning.substring(0, 100)} (${Math.round(iteration.confidence * 100)}%)`);

    // HARD RULE: iteration 1 cannot return an answer. Force the model to run commands first.
    // This catches hallucination (model making up git log output from memory)
    // and refusal (model saying "I cannot execute commands").
    if (i === 0 && iteration.answer) {
      log('WARN', 'explore_iter1_answer_rejected', { preview: iteration.answer.substring(0, 80) });
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
        addMessage('system', `  → related code found:\n${expanded.substring(0, 500)}`);
        // Return expansion as a clearly separated section
        answer += `\n\nRELATED (auto-discovered — these files also interact with the code above):\n${expanded}`;
      }

      log('INFO', 'explore_done', { iterations: String(i + 1), confidence: String(iteration.confidence), reason: 'answer', answerPreview: answer.substring(0, 300) });
      addMessage('system', `  → answer: ${answer.substring(0, 200)}`);
      return capAnswer(answer);
    }

    // No commands and no answer — the model stalled. Return the real data we already gathered
    // (grep/read outputs) rather than the model's meta-reasoning, which is useless to the caller.
    if (iteration.commands.length === 0) {
      log('WARN', 'explore_stuck', { iteration: String(i + 1) });
      const digest = historyDigest(history);
      if (digest) return capAnswer(`Found (from the searches run so far):\n\n${digest}`);
      return iteration.reasoning || 'Investigation inconclusive: no commands suggested.';
    }

    // Execute commands
    const results: string[] = [];
    let anyData = false;
    for (const cmd of iteration.commands) {
      if (!isAllowed(cmd)) {
        results.push(`(blocked: ${cmd.substring(0, 50)} not in allowed list)`);
        continue;
      }
      const output = await execCommand(cmd, cwd);
      const empty = !output || output === '(no output)' || output === '(timeout after 30s)' || output.trim().length === 0;
      if (!empty) anyData = true;
      log('INFO', 'explore_cmd', { iter: String(i + 1), cmd: cmd.substring(0, 120), bytes: String(output.length), empty: String(empty) });
      let trimmed = output;
      if (output.length > MAX_COMMAND_OUTPUT) {
        const cut = output.lastIndexOf('\n', MAX_COMMAND_OUTPUT);
        trimmed = cut > MAX_COMMAND_OUTPUT * 0.5
          ? output.substring(0, cut)
          : output.substring(0, MAX_COMMAND_OUTPUT);
      }
      results.push(trimmed);
    }

    // Stuck-guard: if commands keep returning nothing, don't burn all 12 iterations.
    emptyStreak = anyData ? 0 : emptyStreak + 1;
    if (emptyStreak >= 3) {
      log('WARN', 'explore_empty_streak_bail', { iteration: String(i + 1) });
      addMessage('system', `  → explore: 3 empty searches in a row, stopping. Try a broader question or check the path.`);
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
        log('INFO', 'explore_commit_digest', { iteration: String(i + 1), bytes: String(digest.length) });
        addMessage('system', `  → have data, committing it (model kept re-searching)`);
        return capAnswer(`Found (from the searches run):\n\n${digest}`);
      }
    }

    // Cap history at last 4 steps to keep context manageable
    if (history.length > 4) {
      history.shift();
    }
  }

  // Max iterations reached — prefer a committed answer, else the real command data gathered.
  log('WARN', 'explore_max_iterations', { bestConfidence: String(bestIteration?.confidence ?? 0) });
  if (bestIteration?.answer) return capAnswer(bestIteration.answer);
  const digest = historyDigest(history);
  if (digest) return capAnswer(`Found (from the searches run so far):\n\n${digest}`);
  return capAnswer(bestIteration?.reasoning || 'Reached max iterations with no findings.');
}
