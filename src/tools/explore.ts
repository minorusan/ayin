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
const CONFIDENCE_THRESHOLD = 0.6;
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
 * Extracts method names, class names, interfaces from the answer text and finds:
 * - Who CALLS the methods found (callers)
 * - Who IMPLEMENTS the interfaces found
 * - Where registration/initialization methods are called from
 * Pure grep — no LLM. This catches the files the model wouldn't think to ask for.
 */
async function expandContext(answer: string, cwd: string): Promise<string> {
  // Extract identifiers from the answer to grep for related code.
  // The goal: when explore finds a method that uses a field/dictionary/provider,
  // automatically find who POPULATES or REGISTERS with that field.

  // 1. Method names: Add*, Remove*, Register*, etc.
  const methodPatterns = answer.match(/\b(Add\w+|Remove\w+|Register\w+|Unregister\w+|Initialize\w*|Dispose\w*|OnDestroy|Clear|Reset)\b/g) || [];

  // 2. Private fields: _someField (C# convention)
  const fieldPatterns = answer.match(/\b_[a-z][a-zA-Z]+(?:Provider|Registry|Service|Manager|Dictionary|List|Collection|s)\b/g) || [];

  // 3. Class names: PascalCase with common suffixes
  const classPatterns = answer.match(/\b([A-Z][a-z]+(?:[A-Z][a-z]+){1,}(?:Provider|Service|Controller|Manager|Handler|Factory|Installer))\b/g) || [];

  // 4. Interface names: ISomethingProvider, ISomethingService
  const interfacePatterns = answer.match(/\bI[A-Z][a-zA-Z]+(?:Provider|Service|Registry|Manager)\b/g) || [];

  // 5. For fields that look like collections, also search for Add/Remove patterns
  const collectionFields = fieldPatterns.filter(f => f.endsWith('s') || f.includes('Provider') || f.includes('Registry') || f.includes('Dictionary') || f.includes('List'));
  const derivedMethods: string[] = [];
  for (const field of collectionFields) {
    // _skuProviders → search for ".Add(" near skuProvider or AddSkuProvider
    const baseName = field.replace(/^_/, '').replace(/s$/, '');
    if (baseName.length > 3) {
      derivedMethods.push(`Add${baseName.charAt(0).toUpperCase()}${baseName.slice(1)}`);
      derivedMethods.push(`Remove${baseName.charAt(0).toUpperCase()}${baseName.slice(1)}`);
    }
  }

  const allPatterns = [...new Set([...methodPatterns, ...classPatterns, ...interfacePatterns, ...derivedMethods])];
  if (allPatterns.length === 0) return '';

  const prioritized = allPatterns
    .filter(p => p.length > 4 && p.length < 50)
    .slice(0, 8);

  const results: string[] = [];
  for (const pattern of prioritized) {
    try {
      const output = await execCommand(
        `grep -rn "${pattern}" --include="*.cs" . | grep -v "Binary" | head -8`,
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

**How commands work:**
When you list commands in the "commands" array, the tool RUNS them in the shell and shows you their stdout on the next iteration. You MUST run commands to get data — you cannot know the answer from memory. Never claim you "cannot execute commands" — YES YOU CAN, by listing them in the "commands" array.

**How "answer" works:**
Your "answer" field is pasted VERBATIM into the caller's context. The caller cannot see your commands, reasoning, or this conversation. They only see what you put in "answer". If the question asks "run git log", the answer MUST be the actual stdout from that git log command — not the command itself, not a description. Run the command first, THEN put its output in the answer.

Examples of GOOD and BAD answers:

Question: "Show the StartFirstGameBallFtue method body in BingoGameFtueService.cs"
BAD answer: "The method is at line 238 in Assets/Games/Bingo/Gameplay/Scripts/FTUE/BingoGameFtueService.cs"
GOOD answer:
\`\`\`
File: Assets/Games/Bingo/Gameplay/Scripts/FTUE/BingoGameFtueService.cs
Lines 238-260:
private async UniTaskVoid StartFirstGameBallFtue()
{
    _ftueCancellation = new CancellationTokenSource();
    await UniTask.WaitUntil(() => _firstBallAppeared, cancellationToken: _ftueCancellation.Token);
    ...
}
\`\`\`

Question: "Run git log --format='%aN %ae' -10 -- path/to/file.cs"
BAD answer: "I ran git log and found 10 commits by various authors"
GOOD answer:
\`\`\`
Oleksii Chernov oleksii@company.com
Oleksii Chernov oleksii@company.com
Artem Sukhliak artem@company.com
... (actual verbatim output)
\`\`\`

Question: "Find every place that sets _ftueCancellation to null"
BAD answer: "_ftueCancellation is set to null in 3 places"
GOOD answer:
\`\`\`
Line 112: _ftueCancellation = null;  // in CancelToken()
Line 189: _ftueCancellation = null;  // in Dispose()
Line 245: _ftueCancellation = null;  // in Reset()
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

  if (!question) return 'Error: question required';

  log('INFO', 'explore_start', { question: question.substring(0, 100) });
  addMessage('system', `Exploring: ${question.substring(0, 80)}...`);

  const history: HistoryEntry[] = [];
  let bestIteration: ExploreIteration | null = null;

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
      // If it also didn't provide commands, inject sensible ones based on the question
      if (iteration.commands.length === 0) {
        iteration.commands = [`find . -name "*.cs" | head -5`];  // just to get something going
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

    // No commands and no answer — stuck
    if (iteration.commands.length === 0) {
      log('WARN', 'explore_stuck', { iteration: String(i + 1) });
      return iteration.reasoning || 'Investigation inconclusive: no commands suggested.';
    }

    // Execute commands
    const results: string[] = [];
    for (const cmd of iteration.commands) {
      if (!isAllowed(cmd)) {
        results.push(`(blocked: ${cmd.substring(0, 50)} not in allowed list)`);
        continue;
      }
      const output = await execCommand(cmd, cwd);
      let trimmed = output;
      if (output.length > MAX_COMMAND_OUTPUT) {
        const cut = output.lastIndexOf('\n', MAX_COMMAND_OUTPUT);
        trimmed = cut > MAX_COMMAND_OUTPUT * 0.5
          ? output.substring(0, cut)
          : output.substring(0, MAX_COMMAND_OUTPUT);
      }
      results.push(trimmed);
    }

    history.push({
      reasoning: iteration.reasoning,
      commands: iteration.commands,
      results,
    });

    // Cap history at last 4 steps to keep context manageable
    if (history.length > 4) {
      history.shift();
    }
  }

  // Max iterations reached — return best iteration if available
  log('WARN', 'explore_max_iterations', { bestConfidence: String(bestIteration?.confidence ?? 0) });
  if (bestIteration) {
    return capAnswer(bestIteration.answer || bestIteration.reasoning);
  }
  const lastStep = history[history.length - 1];
  return capAnswer(lastStep
    ? `Reached max iterations. Last finding: ${lastStep.reasoning}`
    : 'Reached max iterations with no findings.');
}
