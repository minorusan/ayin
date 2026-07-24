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
import { spawn } from 'node:child_process';
import { log } from '../log.js';
import { addMessage } from '../ui.js';

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
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
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
    ? `\n**TIME PRESSURE:** Only ${remaining} iteration(s) left. You MUST set the "answer" field with what you have learned so far. Do NOT request more commands unless absolutely necessary.`
    : '';

  const firstIterNote = iteration === 1
    ? `\n**FIRST ITERATION — READ CAREFULLY:**
You have NOT run any commands yet. You DO NOT know the answer yet. You MUST set "answer": null and list commands to run.
The "commands" array you return will be EXECUTED AUTOMATICALLY by the tool. Their stdout will be shown to you in the next iteration. This is how you get data. You cannot answer from memory — the codebase is specific to this project and you must read it.
On iteration 1, setting "answer" to anything other than null is FORBIDDEN.`
    : '';

  return `You are answering a focused question for another agent. Use shell commands to gather data, then return the DATA itself.

Working directory: ${cwd}

**QUESTION TO ANSWER:**
${question}
${context ? `\n**Context provided by caller:**\n${context}\n` : ''}
**Iteration:** ${iteration}/${MAX_ITERATIONS}${pressureNote}${firstIterNote}

**Your previous steps in this investigation:**
${historyText}

**Allowed commands (read-only):** ls, cat, head, tail, grep, find, git show, git log, git blame, git branch, git grep, wc

**This codebase can be ANY language** (TypeScript, JavaScript, Python, Go, C#, Rust, …). Do NOT
assume file extensions. To find a symbol, grep the whole tree WITHOUT an --include filter, e.g.
\`grep -rnI --exclude-dir={.git,node_modules,'dist*','*.bak*',build,vendor,target} "symbolName" .\`
(ALWAYS exclude vendor/build/backup dirs — node_modules, dist*, *.bak*, build — or the output is
noise; the same applies to \`find\`). If you don't know the language yet, run \`ls\` first.
Prefer READING FILE CONTENT (cat/head/grep -A) over listing file names — a list of paths is not
an answer; the code inside them is.

**How commands work:**
When you list commands in the "commands" array, the tool RUNS them in the shell and shows you their stdout on the next iteration. You MUST run commands to get data — you cannot know the answer from memory. Never claim you "cannot execute commands" — YES YOU CAN, by listing them in the "commands" array.

**CRITICAL — commit your answer as soon as you have the data:**
If your "previous steps" above already contain the file content / grep output / git output that
answers the question, DO NOT run more commands. Immediately set "answer" to those verbatim excerpts
and confidence 0.8+. Searching again after you already found it wastes iterations and fails the task.

**How "answer" works:**
Your "answer" field is pasted VERBATIM into the caller's context. The caller cannot see your commands, reasoning, or this conversation. They only see what you put in "answer". If the question asks "run git log", the answer MUST be the actual stdout from that git log command — not the command itself, not a description. Run the command first, THEN put its output in the answer.

Examples of GOOD and BAD answers (language-neutral):

Question: "Show the body of the exploreExecute function"
BAD answer: "The function is at line 298 in tools/explore.ts"
GOOD answer:
\`\`\`
File: tools/explore.ts
Lines 298-312:
export async function exploreExecute(params) {
  const question = params.question;
  ...
}
\`\`\`

Question: "Run git log --format='%aN %ae' -10 -- path/to/file"
BAD answer: "I ran git log and found 10 commits by various authors"
GOOD answer:
\`\`\`
Jane Dev jane@example.com
Jane Dev jane@example.com
Sam Coder sam@example.com
... (actual verbatim output)
\`\`\`

Question: "Find every place that sets activeChatModel to null"
BAD answer: "activeChatModel is set to null in 3 places"
GOOD answer:
\`\`\`
Line 22: activeChatModel = ...;  // in setActiveChatModel()
Line 118: loadedChatModel = null;  // in doSwap()
Line 245: loadedChatModel = null;  // in unloadChatModelVram()
\`\`\`

**Respond in STRICT JSON only:**
{
  "reasoning": "What I just learned from commands (for my own tracking)",
  "commands": ["cmd1", "cmd2"],
  "confidence": 0.5,
  "answer": null
}

**Confidence rules:**
- 0.3 = I have located the target but haven't extracted its content yet
- 0.5 = I have partial content in "answer"
- 0.7+ = "answer" contains the complete data the question asked for
- Do NOT set confidence >= 0.7 unless "answer" contains actual data (file content, git output, code excerpts, file:line locations). Metadata descriptions like "I found X" do NOT count.

**Rules:**
- Maximum 2 commands per iteration.
- Answer field can be up to 3000 characters — use it to include real data, not meta descriptions.
- Return ONLY raw JSON. No markdown fences around the JSON. No prose before or after.`;
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
  // thorough (rag corpus runs): let the investigation run long before the digest-commit guard
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
        { role: 'system', content: 'You are a focused codebase investigator. You only respond with JSON. No prose, no markdown.' },
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
