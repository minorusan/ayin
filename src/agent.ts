/**
 * Agent loop — the core execution cycle.
 *
 * Flow:
 *   1. User input arrives
 *   2. Summarizer updates with user message
 *   3. LLM gets: system prompt + summary + last messages
 *   4. Parse response for tool calls
 *   5. If tool call: execute, feed result back, summarizer updates, goto 3
 *   6. If plain text: display to user, done
 *
 * The LLM always sees: system prompt + summary + last 2 message pairs.
 * This keeps context small and stable.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { cancelActiveThinking } from './connection.js';
import { llmChat, parseToolCalls, renderToolCall, renderToolResult, activeModelId } from './llm/manager.js';
import { llmCall } from './llm.js';
import { webSearch } from './tools/web-search.js';
import { toolsSystemPrompt, getTool, getAllTools, cancelActiveToolExecution } from './tools.js';
import { getSummary, pushMessage, updateSummary } from './summary.js';
import { getGoal } from './goal.js';
import { addMessage, setAgentStatus, setAgentState, setStatus, HEADLESS, formatToolResultForChat, formatToolCallForChat } from './ui.js';
import { log } from './log.js';
import { checkPermission } from './permissions.js';
import { saveArtifact, getSessionArtifacts, readArtifact } from './artifacts.js';
import { recordPrompt, recordTool, recordAnswer } from './session-record.js';
import { getConfig } from './prompts.js';
import { getRules } from './rules.js';
import { syncSession, getSessionId } from './tiferet-session.js';
import { registerTask, completeTask, failTask } from './tools/status.js';
import { extractSignals } from './tools/signals.js';
import { qaBeginTurn, qaNoteTouched, qaShouldRun, qaGate, qaShowCard } from './qa/index.js';
import { guardBeginTurn, guardCheck, guardDirective, guardNoteDenied } from './tool-guard.js';
import { planContextBlock, runPlan } from './plan/index.js';

let interrupted = false;
let immediateCancel = false;
let nudgeForQueuedMessage = false;
const queuedUserInputs: string[] = [];

export function interruptAgent(): void {
  interrupted = true;
  immediateCancel = cancelActiveThinking() || cancelActiveToolExecution() || immediateCancel;
}

export function enqueueAgentMessage(message: string): void {
  queuedUserInputs.push(message);
  log('INFO', 'agent_message_queued', { length: String(message.length) });

  // If the model is currently thinking, abort that request so the next round
  // can incorporate the new user guidance immediately.
  if (cancelActiveThinking()) {
    nudgeForQueuedMessage = true;
  }
}

interface Message {
  role: string;
  content: string;
}

const conversationWindow: Message[] = [];
let currentGoal = '';
let projectExpertise = '';
let ctaDelivered = false;
let ctaTarget = '';  // e.g., file path from write_file instruction

/** Extract the call-to-action from the user prompt — what deliverable is expected? */
function extractCTA(prompt: string): string {
  // Path char class allows dots (so multi-extension like .ayin.md works); strip trailing punctuation post-match.
  const strip = (p: string) => p.replace(/[.,;:!?)]+$/, '');
  const writeMatch = prompt.match(/write.*?(?:to|path[=:])\s*([^\s,"']+\.\w+(?:\.\w+)*)/i);
  if (writeMatch) return strip(writeMatch[1]);
  const reportMatch = prompt.match(/report.*?(?:to|at|path[=:])\s*([^\s,"']+\.\w+(?:\.\w+)*)/i);
  if (reportMatch) return strip(reportMatch[1]);
  const outputMatch = prompt.match(/(?:output|save|create)\s+(?:to|at|file)?\s*([^\s,"']+\.\w+(?:\.\w+)*)/i);
  if (outputMatch) return strip(outputMatch[1]);
  return '';
}

/** Detect project type from filesystem — no LLM, runs once on first task. */
function detectProjectExpertise(cwd: string): string {
  const exists = (p: string) => { try { return existsSync(join(cwd, p)); } catch { return false; } };
  const hasFileWith = (dir: string, pattern: string, ext: string) => {
    try {
      const result = execSync(`grep -rl "${pattern}" "${join(cwd, dir)}" --include="*${ext}" 2>/dev/null | head -1`, { timeout: 5000 }).toString().trim();
      return result.length > 0;
    } catch { return false; }
  };

  if (exists('Assets') && exists('ProjectSettings')) {
    const parts = ['Unity C# mobile game'];
    if (hasFileWith('Assets', 'UniTask', '.cs')) parts.push('async via UniTask (CancellationTokenSource lifecycle, async state machines, MoveNext patterns)');
    if (hasFileWith('Assets', 'Zenject', '.cs')) parts.push('Zenject dependency injection');
    if (hasFileWith('Assets', 'LiveOps', '.cs')) parts.push('live-ops system (DynamicInAppOperation, provider registration, popup lifecycle)');
    return parts.join('. ');
  }
  if (exists('tsconfig.json')) return 'TypeScript project';
  if (exists('package.json')) return 'Node.js project';
  if (exists('Cargo.toml')) return 'Rust project';
  if (exists('go.mod')) return 'Go project';
  if (exists('requirements.txt') || exists('pyproject.toml')) return 'Python project';
  return '';
}

function getWindowSize(): number { return getConfig('windowSize', 12); }
function getMaxRounds(): number { return HEADLESS ? 1000 : getConfig('maxToolRounds', 15); }

let exploreCallCount = 0;
const MAX_EXPLORE_CALLS = 5;
const gatheredFacts: string[] = [];
type JudgeVerdict = { confidence: 'high' | 'mid' | 'low'; reasoning: string } | null;
let judgeVerdict: JudgeVerdict = null;
const JUDGE_INTERVAL = 5;
let totalToolCalls = 0;
let judgeRoundsGranted = 0; // extra rounds granted by mid-confidence verdict

/** Reset per-turn counters on new user turn */
function resetCounters(): void {
  exploreCallCount = 0;
  guardBeginTurn(); // repeat/deny/poll budget is per turn — see tool-guard.ts
  gatheredFacts.length = 0;
  judgeVerdict = null;
  totalToolCalls = 0;
  judgeRoundsGranted = 0;
  directions.length = 0;
}


/** Direction tracking — the model is a pendulum. Each critic rejection adds a direction
 *  (what to avoid / what to try). Circle detection prevents oscillation.
 *  Max 5 direction changes in headless, 1 in interactive (then ask user). */
const directions: string[] = [];
const MAX_DIRECTIONS = 5;

/**
 * Three-stage critic system. Each stage is a shallow LLM call (MoE sweet spot).
 *
 * Stage 1 — Unanchored peer: sees facts ONLY (no proposed answer), forms independent conclusion.
 *           This avoids anchoring bias.
 * Stage 2 — Arbiter: sees both the agent's answer AND the peer's conclusion, picks which is
 *           more consistent with the evidence. Pure ranking task.
 * Stage 3 — If arbiter picks the peer's conclusion, that becomes the new direction.
 *
 * Returns null if agent's answer wins (or on error), or the better direction if peer wins.
 */
async function runCritic(proposedAnswer: string, facts: string[]): Promise<string | null> {
  const factsText = facts.map((f, i) => `Fact ${i + 1}: ${f}`).join('\n\n');

  // Generic signal extractor — for every action found, check if its counterpart exists.
  // Pure pattern matching, no LLM. Works across any OOP codebase.
  const signalsText = extractSignals(facts, currentGoal);
  if (signalsText) log('INFO', 'critic_signals', { signals: signalsText.substring(0, 500) });

  // Stage 1: Unanchored peer — different persona activates different MoE experts
  let peerConclusion: string;
  try {
    const peerPrompt = `You are a senior software architect with deep experience in runtime failure analysis and system lifecycle design. You specialize in identifying root causes by tracing registration, initialization, and teardown flows.

Given ONLY these facts, what is the most likely root cause of the error? Do not speculate beyond the facts. One paragraph.
${signalsText}
${factsText.substring(0, 5000)}`;

    const peerResponse = await llmChat([{ role: 'user', content: peerPrompt }]);
    peerConclusion = peerResponse.trim();
    log('INFO', 'critic_peer', { conclusion: peerConclusion.substring(0, 300) });
    addMessage('system', `[peer review: ${peerConclusion.substring(0, 100)}...]`);
  } catch {
    return null;
  }

  // Stage 2: Arbiter — rate each explanation independently (no position bias)
  // Two separate calls, each sees only ONE explanation + facts.
  // Code compares scores. Like a blind evaluation.
  try {
    const ratePrompt = (persona: string, explanation: string) =>
      `${persona}

Rate how well this explanation is supported by the evidence. Score 1-10.

EVIDENCE:
${factsText.substring(0, 3000)}
${signalsText}

EXPLANATION:
${explanation.substring(0, 1500)}

Score 1-10 where:
1-3 = contradicts evidence or unsupported claims
4-6 = partially supported, some gaps or speculation
7-10 = well supported by specific evidence

Respond with just the number and one sentence why.`;

    const [originalResponse, peerResponse] = await Promise.all([
      llmChat([{ role: 'user', content: ratePrompt(
        'You are a QA engineer who evaluates technical claims strictly against evidence. You flag any claim that is not directly supported by the provided facts. Speculation without evidence scores low.',
        proposedAnswer
      ) }]),
      llmChat([{ role: 'user', content: ratePrompt(
        'You are a QA engineer who evaluates technical claims strictly against evidence. You flag any claim that is not directly supported by the provided facts. Speculation without evidence scores low.',
        peerConclusion
      ) }]),
    ]);

    const parseScore = (r: string): number => {
      const m = r.match(/\b(\d+)\b/);
      return m ? parseInt(m[1], 10) : 5;
    };

    const originalScore = parseScore(originalResponse);
    const peerScore = parseScore(peerResponse);

    log('INFO', 'critic_arbiter', {
      originalScore: String(originalScore),
      peerScore: String(peerScore),
      originalReason: originalResponse.trim().substring(0, 150),
      peerReason: peerResponse.trim().substring(0, 150),
    });

    addMessage('system', `[arbiter: original=${originalScore}/10, peer=${peerScore}/10]`);

    if (peerScore > originalScore) {
      return `Independent analysis (scored ${peerScore}/10 vs ${originalScore}/10) suggests a different root cause: ${peerConclusion}`;
    }

    // Original wins or tie — pass
    return null;
  } catch {
    return null;
  }
}

/** Circle detection — check if a new direction is essentially the same as a previous one. */
async function isCircling(newDirection: string): Promise<boolean> {
  if (directions.length === 0) return false;

  const prompt = `Previous directions tried:\n${directions.map((d, i) => `${i + 1}. ${d.substring(0, 150)}`).join('\n')}\n\nNew direction:\n${newDirection.substring(0, 150)}\n\nIs the new direction essentially the same as any previous one? YES or NO.`;

  try {
    const response = await llmChat([{ role: 'user', content: prompt }]);
    return response.trim().toUpperCase().startsWith('YES');
  } catch {
    return false;
  }
}

/** Judge call — evaluates confidence level from gathered facts.
 *  Returns HIGH (ready to produce output), MID (promising, need more evidence),
 *  or LOW (stuck or wrong direction).
 *  This is a classification task — plays to MoE strengths. */
async function callJudge(task: string, facts: string[]): Promise<JudgeVerdict> {
  if (facts.length === 0) return { confidence: 'low', reasoning: 'No facts gathered yet.' };

  const factsText = facts.map((f, i) => `${i + 1}. ${f}`).join('\n\n');
  const prompt = `You are evaluating an agent's progress on a task.

Task (first line): ${task.split('\n')[0]}

Facts the agent has gathered so far:
${factsText}

Rate the agent's readiness to produce a final answer:

HIGH — the facts contain the specific evidence needed (file paths, code excerpts, field names, root cause). The agent can write a complete answer now.

MID — the agent is on the right track and has partial evidence, but needs a few more specific facts to be conclusive.

LOW — the agent has not found relevant evidence, is going in circles, or the facts don't relate to the task.

Respond with exactly one JSON object:
{"confidence": "high", "reasoning": "one sentence why"}`;

  try {
    const response = await llmChat([{ role: 'user', content: prompt }]);
    const cleaned = response.trim();
    // Parse JSON from response
    const match = cleaned.match(/\{[^}]+\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const conf = String(parsed.confidence || '').toLowerCase();
      const reasoning = String(parsed.reasoning || '');
      if (conf === 'high' || conf === 'mid' || conf === 'low') {
        log('INFO', 'judge_verdict', { confidence: conf, reasoning, factCount: String(facts.length) });
        return { confidence: conf, reasoning };
      }
    }
    // Fallback: look for keywords
    const upper = cleaned.toUpperCase();
    if (upper.includes('HIGH')) return { confidence: 'high', reasoning: cleaned };
    if (upper.includes('MID')) return { confidence: 'mid', reasoning: cleaned };
    return { confidence: 'low', reasoning: cleaned };
  } catch (err) {
    log('ERROR', 'judge_error', { error: String(err) });
    return { confidence: 'mid', reasoning: 'Judge call failed.' };
  }
}

function pushToWindow(role: string, content: string): void {
  conversationWindow.push({ role, content });
  while (conversationWindow.length > getWindowSize()) {
    conversationWindow.shift();
  }
}

/**
 * Load prior turns into the agent's window — what makes `/resume` actually resume.
 *
 * `conversationWindow` is the ONLY source of history `buildMessages` reads, and it was
 * module-private with no way in: a resume restored the summary store (which nothing reads) and left
 * the model with an empty window, so it had no idea what the session had been about. The chat
 * transcript is repainted separately by the caller — this is the model's side.
 */
export function restoreConversation(turns: Array<{ role: string; content: string }>): number {
  conversationWindow.length = 0;
  const max = getWindowSize();
  for (const t of turns.slice(-max)) {
    if (t.role !== 'user' && t.role !== 'assistant') continue; // tool traffic is not replayed
    conversationWindow.push({ role: t.role, content: t.content });
  }
  log('INFO', 'conversation_restored', { turns: String(conversationWindow.length) });
  return conversationWindow.length;
}

function buildMessages(round: number, maxRounds: number): Message[] {
  const summary = getSummary();
  const messages: Message[] = [];
  // NOTE: `summary.summary` was read here and then never used — the rolling summary has not reached
  // the model for as long as that line existed, and `updateSummary` is disabled besides ("was
  // hallucinating"), so it is empty for new sessions. It IS injected below when non-empty, which is
  // what makes a RESTORED summary from `/resume` mean something.

  let systemContent = toolsSystemPrompt();

  // WHAT it runs on, not just who it is.
  //
  // The prompt used to say "You are Ayin, a terminal coding agent" and nothing about the model.
  // Asked "what model are you?", a distilled model primed by 12k chars of agentic-harness prompt
  // fills that gap with a famous vendor and states it confidently: the same build claimed
  // "Claude, developed by Anthropic" in one session and "OpenAI's o3" in the next. Ayin KNOWS the
  // answer (the served model id) — so it says it. Verified: with this line qwen3.6 answers
  // "Ayin, running on qwen3.6:27b served by the Maradel backend"; without it, it confabulates.
  const servedModel = activeModelId();
  if (servedModel) {
    const identity =
      `You are running on the local model "${servedModel}", served by the Maradel backend — you are ` +
      `NOT Claude, ChatGPT, Gemini or any hosted assistant. If asked what model you are, answer: ` +
      `Ayin running on ${servedModel}. Never guess a vendor or model name.`;
    const anchored = systemContent.replace(/^(You are Ayin[^\n]*)/, `$1\n${identity}`);
    // A custom system prompt (prompts.json) may not start that way — then just put it on top.
    systemContent = anchored === systemContent ? `${identity}\n\n${systemContent}` : anchored;
  }

  // Project expertise — detected from filesystem, injected at the top
  if (projectExpertise) {
    systemContent = `You are an expert in: ${projectExpertise}.\n\n${systemContent}`;
  }

  const rules = getRules();
  if (rules) {
    systemContent = `<rules>\n${rules}\n</rules>\n\n${systemContent}`;
  }

  // Session goal — the auto-determined overall direction (goal.ts). This is the anti-wander
  // anchor: it stays stable while `currentGoal` (the latest raw input) changes turn to turn.
  const sessionGoal = getGoal();
  if (sessionGoal) {
    systemContent += `\n\nSession goal (the user's overall direction — keep every step aligned with this and do not wander off it): ${sessionGoal}`;
  }

  if (currentGoal) {
    systemContent += `\n\nCurrent task: ${currentGoal}`;
  }

  // Auto-research grounding for this turn (web search ran before the base call, per the trigger).
  // A rolling summary carried in from a resumed session — prior context the window can't hold.
  if (summary.summary) {
    systemContent += `\n\nContext from earlier in this session (restored):\n${summary.summary}`;
  }

  // A plan produced before this turn (plan mode) — the agent's marching orders for a big request.
  if (planContext) {
    systemContent += `\n\n${planContext}`;
  }

  if (diagramContext) {
    systemContent += `\n\n${diagramContext}`;
  }

  if (researchContext) {
    systemContent += `\n\n${researchContext}`;
  }

  // Programmatic fact tracker — no LLM, just concatenated explore results.
  if (gatheredFacts.length > 0) {
    systemContent += `\n\nFacts gathered so far (${gatheredFacts.length} explore calls):\n`;
    gatheredFacts.forEach((fact, i) => {
      systemContent += `${i + 1}. ${fact}\n\n`;
    });
  }

  // Blocked / denied calls — a refusal that only lives in a tool_response scrolls out of the window
  // and the model tries again. Here it is present every round for as long as the turn lasts.
  const blockedDirective = guardDirective();
  if (blockedDirective) {
    systemContent += `\n\n<blocked-calls>\n${blockedDirective}\n</blocked-calls>`;
  }

  // Direction history — what the critic rejected, so the model doesn't repeat
  if (directions.length > 0) {
    systemContent += `\n\nPrevious approaches that were rejected by the internal reviewer:\n`;
    directions.forEach((d, i) => {
      systemContent += `${i + 1}. ${d}\n`;
    });
    systemContent += `Do not repeat these approaches. Try a different angle.\n`;
  }

  // Judge verdict — routes the agent's next action
  if (judgeVerdict?.confidence === 'high') {
    systemContent += `\n\nYour gathered facts are sufficient to produce a complete answer. Write your final output now.`;
  } else if (judgeVerdict?.confidence === 'low' && judgeRoundsGranted <= 0) {
    systemContent += `\n\nProgress evaluation: ${judgeVerdict.reasoning}. Report what you have found so far — do not continue exploring.`;
  }

  // CTA tracking — remind the model of its deliverable if overdue
  const remaining = maxRounds - round - 1;
  if (ctaTarget && !ctaDelivered && round >= 5) {
    systemContent += `\n\nYour deliverable: write the final output to ${ctaTarget}. You have not done this yet.`;
  }

  if (remaining <= 3) {
    systemContent += `\n\n[URGENT: Round ${round + 1}/${maxRounds}. Only ${remaining} round(s) left. Write your final answer now.]`;
  } else if (round >= Math.floor(maxRounds * 0.75)) {
    systemContent += `\n\n[Round ${round + 1}/${maxRounds}. Past 75% — converge toward your conclusion.]`;
  } else {
    systemContent += `\n\n[Round ${round + 1}/${maxRounds}.]`;
  }

  messages.push({ role: 'system', content: systemContent });

  // Observation masking: keep last 4 messages verbatim, compress older ones.
  // tool_responses → 1-line stub; assistant tool calls → tool name + param preview.
  const VERBATIM_TAIL = 4;
  const maskStart = Math.max(0, conversationWindow.length - VERBATIM_TAIL);
  for (let i = 0; i < conversationWindow.length; i++) {
    const msg = conversationWindow[i];
    if (i >= maskStart) {
      messages.push(msg);
      continue;
    }
    // No truncation — with 65K context, let the model see full history.
    // Only compress very old tool responses to save some space.
    if (msg.role === 'user' && msg.content.startsWith('<tool_response>') && msg.content.length > 2000) {
      // Keep first meaningful chunk — truncate at last newline before 2000 chars
      const cut = msg.content.lastIndexOf('\n', 2000);
      const trimmed = cut > 100 ? msg.content.substring(0, cut) : msg.content.substring(0, 2000);
      messages.push({ role: msg.role, content: trimmed + '\n</tool_response>' });
    } else {
      messages.push(msg);
    }
  }
  return messages;
}

function drainQueuedMessages(): number {
  let drained = 0;
  while (queuedUserInputs.length > 0) {
    const message = queuedUserInputs.shift()!;
    currentGoal = message;
    pushToWindow('user', message);
    pushMessage('user', message);
    drained++;
  }
  if (drained > 0) {
    log('INFO', 'agent_messages_drained', { count: String(drained) });
  }
  return drained;
}

/** Truncate goal to a single short line for the summarizer — avoids eating the whole summary budget. */
function summarizableGoal(): string {
  const first = currentGoal.split('\n')[0].trim();
  return first.length > 120 ? first.substring(0, 117) + '...' : first;
}

/** Fire-and-forget Tiferet sync — only runs when a session is active */
function triggerSync(): void {
  if (!getSessionId()) return;
  const s = getSummary();
  syncSession(
    s.summary,
    s.recent,
    getSessionArtifacts(),
    readArtifact,
    process.cwd(),
    getGoal(), // the record has no place for session state; the picker needs it to label a session
  ).catch(() => {});
}

/** Returns true if two strings are substantially the same (duplicate detection). */
function isSimilarText(a: string, b: string): boolean {
  if (!a || !b) return false;
  // Fast path: same first 80 chars = same response
  const head = Math.min(80, Math.min(a.length, b.length));
  if (a.substring(0, head) === b.substring(0, head)) return true;
  // Word overlap: >70% of shorter text's words appear in longer text
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const [smaller, larger] = wordsA.size < wordsB.size ? [wordsA, wordsB] : [wordsB, wordsA];
  if (smaller.size === 0) return false;
  let overlap = 0;
  for (const w of smaller) { if (larger.has(w)) overlap++; }
  return overlap / smaller.size > 0.7;
}

// ── auto-research grounding ───────────────────────────────────────────
// Near-deterministic: if the prompt contains grounded/citing/citation/research, run a web search
// BEFORE the base call and pre-prompt its result into the turn — so gemma answers grounded, with
// citations, scientific-methods-first. Query is formulated from the prompt + the user's stack
// (SYSTEM_INFO env, with a baked default). Opt out with AYIN_RESEARCH=0.
const RESEARCH_TRIGGER = /(grounded|citing|citation|research)/i;
const SYSTEM_INFO_DEFAULT =
  'Unity3D (visualize anything — 3D/AR; embeddable into Flutter), Flutter (desktop + web UI), ' +
  'Node/TS backend, Arduino (embedded). Hardware: an RTX 3090 eGPU LLM lab on a dedicated i3 NUC; ' +
  'two i7 laptops (Windows + macOS); a Raspberry Pi — distributed systems are feasible.';
function systemInfo(): string { return process.env.SYSTEM_INFO || SYSTEM_INFO_DEFAULT; }

let researchContext = ''; // pre-prompted into the base call for this turn; reset each runResearch

async function runResearch(userInput: string): Promise<void> {
  researchContext = '';
  if (process.env.AYIN_RESEARCH === '0' || !RESEARCH_TRIGGER.test(userInput)) return;
  try {
    setAgentStatus('Researching (grounding)...');
    // 1) formulate ONE focused, scientific-leaning search query from the request + the user's stack.
    let query = userInput;
    try {
      const q = (await llmCall(
        `The user wants a grounded, cited answer. Extract ONE concise web-search query (scientific/` +
        `technical framing) for their request, mindful of their stack.\nRequest: ${userInput}\n` +
        `Stack: ${systemInfo()}\nReturn ONLY the query on one line, no preamble.`,
      )).trim().split('\n')[0].replace(/^["']|["']$/g, '').slice(0, 200);
      if (q.length > 3) query = q;
    } catch { /* formulation failed — fall back to the raw prompt as the query */ }
    // 2) web search (SearXNG → DuckDuckGo) → real hits + sources.
    const results = await webSearch(query);
    // 3) pre-prompt the base call: grounded, scientific→household, tailored to the user's stack.
    researchContext =
      `<research-grounding>\nThe user asked for a grounded / researched answer, so a web search was run first.\n\n` +
      `Research topic: ${query}\n\n${results}\n\n` +
      `When you answer:\n` +
      `- Lead with SCIENTIFIC methods of solving the problem; THEN review practical/household methods.\n` +
      `- Cite the sources above (title + URL) for the claims you use.\n` +
      `- Tailor recommendations to the user's stack + hardware: ${systemInfo()}\n` +
      `</research-grounding>`;
    log('INFO', 'research_grounding', { query: query.slice(0, 120) });
  } catch (err) {
    log('WARN', 'research_failed', { error: err instanceof Error ? err.message : String(err) });
    researchContext = '';
  } finally {
    setAgentStatus('');
  }
}

// ── auto-diagram ("explain it with a picture") ─────────────────────────
// Same shape as auto-research above, and for the same reason: some intents should not depend on the
// model remembering it has a tool. "I don't understand", "explain better", "give me a diagram" →
// build a VALIDATED PlantUML diagram BEFORE the base call and pre-prompt its path + source, so the
// answer is written around the picture instead of promising one.
//
// The user's words go to the diagram tool VERBATIM as the subject — no extra LLM call to "formulate
// a subject". Every call queues on one shared GPU slot, and a turn that already costs 1-4 draft
// rounds should not also pay for a paraphrase.
//
// Opt out with AYIN_DIAGRAM=0.
// Word boundaries are load-bearing here. A false fire costs a whole extra generation on a shared,
// often-starved GPU, so the loose version was measurably wrong: bare `diagram` matched
// "diagrammatic", and bare `schema` matched "add a database schema migration file" — a phrase that
// comes up constantly in ordinary DB work and has nothing to do with wanting a picture. `schema`
// now only counts when someone asks to be SHOWN one.
const DIAGRAM_TRIGGER = new RegExp([
  '\\bdiagrams?\\b', 'plant ?uml', '\\bpuml\\b', 'visuali[sz]e', '\\bschematic\\b',
  '(show|draw|give|need|want|make)\\s+(me\\s+)?(a\\s+|the\\s+)?schema\\b',
  'flow ?charts?\\b', 'sequence chart',
  'explain (it |this |that )?better', "don'?t (understand|get it)", 'do not understand',
  'not clear', '\\bunclear\\b', 'confus(ed|ing)', '\\bdraw\\b',
].join('|'), 'i');

let diagramContext = ''; // pre-prompted into the base call for this turn
let planContext = '';    // a plan produced before the turn (plan/index.ts), pre-prompted the same way

async function runDiagram(userInput: string): Promise<void> {
  diagramContext = '';
  if (process.env.AYIN_DIAGRAM === '0' || !DIAGRAM_TRIGGER.test(userInput)) return;
  try {
    setAgentStatus('Drawing a diagram...');
    const { makeDiagram, formatDiagramResult } = await import('./tools/diagram.js');
    // Ground it in whatever this session already established — without facts the picture is generic.
    const context = [getGoal() ? `Session goal: ${getGoal()}` : '', gatheredFacts.slice(-3).join('\n\n')]
      .filter(Boolean).join('\n\n').slice(0, 4000);
    const r = await makeDiagram(userInput, { context: context || undefined });
    if (!r.ok) { log('WARN', 'auto_diagram_failed', { error: (r.error ?? '').slice(0, 120) }); return; }
    diagramContext =
      `<diagram>\nThe user asked for something to be made clearer, so a PlantUML diagram was generated ` +
      `and validated BEFORE this turn.\n\n${formatDiagramResult(r)}\n\n` +
      `When you answer:\n` +
      `- Reference the file by path (${r.file}) — the user can open it now.\n` +
      `- Walk through the diagram in prose: what each part is and why the arrows go that way.\n` +
      `- Do NOT paste the PlantUML source again, and do NOT offer to make a diagram — it exists.\n` +
      `</diagram>`;
    addMessage('system', `Diagram: ${r.file}${r.image ? ` (rendered ${r.image})` : ''}`);
    log('INFO', 'auto_diagram', { file: r.file ?? '', kind: r.kind ?? '', rounds: String(r.rounds) });
  } catch (err) {
    log('WARN', 'auto_diagram_error', { error: err instanceof Error ? err.message : String(err) });
    diagramContext = '';
  } finally {
    setAgentStatus('');
  }
}

export async function runAgent(userInput: string): Promise<void> {
  currentGoal = userInput;
  recordPrompt(userInput); // consolidated per-session record (prompts + tools + answers)
  pushToWindow('user', userInput);
  pushMessage('user', userInput);
  interrupted = false;
  immediateCancel = false;
  nudgeForQueuedMessage = false;
  let lastPrintedText = '';
  resetCounters();
  // QA gate: snapshot what was already dirty BEFORE this turn touches anything, so pre-existing
  // uncommitted work is never reviewed as if this turn produced it.
  qaBeginTurn();

  // Detect project expertise once
  if (!projectExpertise) {
    projectExpertise = detectProjectExpertise(process.cwd());
    if (projectExpertise) {
      log('INFO', 'project_detected', { expertise: projectExpertise });
    }
  }

  // Extract CTA — what deliverable does the user expect?
  ctaDelivered = false;
  ctaTarget = extractCTA(userInput);
  if (ctaTarget) log('INFO', 'cta_extracted', { target: ctaTarget });

  // Plan mode (deterministic size trigger + one triage call) — a big cross-feature request gets a
  // written plan BEFORE any work starts, and the plan goes into this turn's context.
  planContext = '';
  const plan = await runPlan(userInput, getGoal());
  if (plan) planContext = planContextBlock(plan);

  // Auto-research grounding (deterministic trigger) — web search BEFORE the base call, pre-prompted.
  await runResearch(userInput);
  // Auto-diagram (deterministic trigger) — a validated .puml BEFORE the base call, pre-prompted.
  await runDiagram(userInput);

  const maxRounds = getMaxRounds();
  roundLoop: for (let round = 0; round < maxRounds; round++) {
    drainQueuedMessages();

    if (interrupted) {
      await handleInterrupt(userInput, round);
      return;
    }

    // Judge-based progression — replaces self-reflection checkpoints

    const messages = buildMessages(round, maxRounds);
    setAgentStatus(round === 0 ? 'Thinking...' : `Thinking... (round ${round + 1})`);
    log('INFO', 'llm_call', { round: String(round), windowSize: String(conversationWindow.length) });

    let response: string;
    try {
      response = await llmChat(messages);
    } catch (err) {
      setAgentStatus('');
      if (nudgeForQueuedMessage) {
        nudgeForQueuedMessage = false;
        continue;
      }
      if (interrupted) {
        addMessage('system', immediateCancel ? 'Cancelled.' : 'Interrupted.');
        immediateCancel = false;
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      addMessage('system', `LLM error: ${msg}`);
      log('ERROR', 'llm_error', { error: msg });
      return;
    }

    // Postprocessing (ayin layer): parsing tool calls out of the raw model text. Usually
    // instant, but a malformed/huge response makes this visible — surface it honestly.
    setStatus({ llm: { phase: 'postprocessing', detail: 'ayin' } });
    const parsed = parseToolCalls(response);
    setStatus({ llm: null });
    const hasToolCalls = parsed.toolCalls.length > 0;

    // For tool-call rounds: print pre-tool reasoning immediately (both modes)
    if (hasToolCalls && parsed.text) {
      addMessage('assistant', parsed.text);
      lastPrintedText = parsed.text;
    }

    // Sync immediately after every assistant message so bad replies are captured
    // before any tool runs. The syncing flag prevents stacking.
    triggerSync();

    if (!hasToolCalls) {
      recordAnswer(response);
      pushToWindow('assistant', response);
      pushMessage('assistant', response);

      if (HEADLESS) {
        // CTA gate — if there's a deliverable the model hasn't produced, don't exit
        if (ctaTarget && !ctaDelivered && round < maxRounds - 2) {
          pushToWindow('user', `<system>You have not yet written your deliverable to ${ctaTarget}. Call write_file with your final output now.</system>`);
          log('INFO', 'cta_reminder_on_text', { round: String(round), target: ctaTarget });
          continue;
        }

        // Double-text exit — only after CTA is delivered or truly exhausted
        const prevMsg = conversationWindow.length >= 2 ? conversationWindow[conversationWindow.length - 2] : null;
        const prevWasText = prevMsg?.role === 'assistant' && !prevMsg.content.includes('<function=');
        if (!prevWasText) {
          // First text response after a tool call — print and continue
          if (parsed.text) { addMessage('assistant', parsed.text); lastPrintedText = parsed.text; }
          log('INFO', 'headless_text_continue', { round: String(round) });
          continue;
        }

        // Exit round: only print if content is new (not a duplicate of the previous text)
        if (parsed.text && !isSimilarText(parsed.text, lastPrintedText)) {
          addMessage('assistant', parsed.text);
        } else if (parsed.text) {
          log('INFO', 'agent_skip_duplicate_print', { round: String(round) });
        }
        lastPrintedText = '';
        log('INFO', 'agent_done', { round: String(round), reason: 'double_text', ctaDelivered: String(ctaDelivered) });
      } else {
        // Interactive mode: always print immediately
        if (parsed.text) addMessage('assistant', parsed.text);
      }

      setAgentStatus('');
      triggerSync();

      // ── QA gate ──────────────────────────────────────────────────────
      // The model has just claimed it is finished. Deterministic condition: files changed this turn
      // AND this message reads like a completion report. If it fails review, the issues go back into
      // the loop as a system turn and the agent fixes them — capped at `qaMaxPasses`.
      if (!interrupted) {
        const gate = qaShouldRun(response);
        log('INFO', 'qa_gate_condition', { run: String(gate.run), why: gate.why, files: String(gate.files.length) });
        if (gate.run) {
          const outcome = await qaGate(getGoal() || currentGoal, response, gate.files, () => interrupted);
          qaShowCard(outcome.card);
          if (outcome.action === 'fix' && outcome.feedback && !interrupted) {
            pushToWindow('user', outcome.feedback);
            // Give the repair a real runway: without this a gate that fires on the last round has
            // no rounds left to fix anything. Bounded by qaMaxPasses, not by rounds.
            round = Math.min(round, Math.max(0, maxRounds - 5));
            log('INFO', 'qa_fix_pass', { pass: String(outcome.pass), issues: String(outcome.verdict?.issues.length ?? 0), roundReset: String(round) });
            continue;
          }
        }
      }

      await writeHandoff('text_output', currentGoal, round, maxRounds);
      log('INFO', 'agent_done', { round: String(round), hasText: String(!!parsed.text), ctaDelivered: String(ctaDelivered) });
      return;
    }

    // Multi-tool batch: a single LLM response may contain N tool calls
    // (Gemma4 regularly chains read → write → bash). Execute sequentially,
    // feed each result back as its own assistant/user turn pair.
    const seenInBatch = new Set<string>();
    for (let tcIdx = 0; tcIdx < parsed.toolCalls.length; tcIdx++) {
      const { name, params } = parsed.toolCalls[tcIdx];
      const firstInBatch = tcIdx === 0;
      const textPrefix = firstInBatch ? parsed.text : '';

      // Intra-batch dedup — occasionally a model emits the same call twice
      // in one response ("write … then write the same file again to confirm").
      const batchKey = `${name}|${Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('|')}`;
      if (seenInBatch.has(batchKey)) {
        addMessage('system', `${name}: skipped (same call already in this response)`);
        log('INFO', 'intrabatch_duplicate_skip', { tool: name });
        continue;
      }
      seenInBatch.add(batchKey);

      const tool = getTool(name);
      if (!tool) {
        setAgentStatus('');
        const shellLike = /^(git|npm|node|python|bash|sh|curl|grep|find|ls|cat|cd|mv|cp|rm|mkdir|echo|sed|awk|jq)$/.test(name);
        const availableNames = getAllTools().map(t => t.name).join(', ');
        const hint = shellLike
          ? ` There is no "${name}" tool. To run shell commands use the bash tool: bash(command="${name} ...")`
          : ` Available tools: ${availableNames}.`;
        const errMsg = `Unknown tool: ${name}.${hint}`;
        addMessage('system', `Unknown tool: ${name}`);
        pushToWindow('assistant', textPrefix ? `${textPrefix}\n[Called unknown tool: ${name}]` : `[Called unknown tool: ${name}]`);
        pushToWindow('user', renderToolResult(`Error: ${errMsg}`));
        continue;
      }

      // Missing required params → the model's tool call didn't parse cleanly.
      // Tell it explicitly what's missing instead of silently running a broken call
      // and then blocking its retry as a "duplicate".
      const missingRequired = (tool.parameters || [])
        .filter(p => p.required && !(params[p.name] && String(params[p.name]).length > 0))
        .map(p => p.name);
      if (missingRequired.length > 0) {
        setAgentStatus('');
        const missingNames = missingRequired.join(', ');
        const errMsg = `Missing required parameter(s) for ${name}: ${missingNames}. Use: <function=${name}>\n<parameter=${missingRequired[0]}>\nvalue\n</parameter>\n...\n</function>`;
        addMessage('system', `${name}: missing ${missingNames}`);
        pushToWindow('assistant', textPrefix ? `${textPrefix}\n[${name}: missing ${missingNames}]` : `[${name}: missing ${missingNames}]`);
        pushToWindow('user', renderToolResult(errMsg));
        log('WARN', 'missing_required_params', { tool: name, missing: missingNames });
        continue;
      }

      // Repeat / refusal / polling policy (tool-guard.ts). A repeat is warned once, then BLOCKED for
      // the turn and named in the system prompt — the old warn-every-time behaviour is what let the
      // model re-emit the same call five times in a row. Polling a backgrounded task is exempt.
      const guard = guardCheck(name, params);
      if (!guard.allow) {
        setAgentStatus('');
        addMessage('system', `${name}: ${guard.label ?? 'blocked'}`);
        pushToWindow('assistant', textPrefix ? `${textPrefix}\n[${name}: ${guard.label ?? 'blocked'}]` : `[${name}: ${guard.label ?? 'blocked'}]`);
        pushToWindow('user', renderToolResult(guard.note ?? 'This call was blocked.'));
        continue;
      }

      if (name === 'explore') {
        exploreCallCount++;
        log('INFO', 'explore_call_count', { count: String(exploreCallCount) });
      }

      const paramPreview = Object.entries(params)
        .map(([k, v]) => `${k}=${v.length > 60 ? `${v.substring(0, 57)}...` : v}`)
        .join(', ');

      setAgentStatus('');
      const permission = await checkPermission(name, params, textPrefix);
      if (permission === 'deny') {
        // A refusal is remembered for the whole turn: this exact call is now dead, and the guard says
        // so in the system prompt every round. Re-asking a denied call is the other half of the loop
        // the warn-only detector used to allow.
        guardNoteDenied(name, params);
        // Read-only mode (AYIN_READONLY=1): soft-deny — the tool is unavailable, but DON'T abort
        // the run the way an interactive user-deny does. Feed a denial result back and continue so
        // the model reports with read tools. Without this the doggo dies on its first bash/explore.
        if (process.env.AYIN_READONLY === '1') {
          log('INFO', 'tool_denied_readonly', { tool: name });
          addMessage('system', `Denied (read-only): ${name}`);
          const denyCall = renderToolCall({ name, params });
          pushToWindow('assistant', textPrefix ? `${textPrefix}\n\n${denyCall}` : denyCall);
          pushToWindow('user', renderToolResult(`${name} is unavailable in read-only mode. Investigate using only read_file, grep, and find_files — do not write files or run shell/bash. Then report your findings.`));
          continue roundLoop;
        }
        addMessage('system', `Denied: ${name}(${paramPreview})`);
        log('INFO', 'tool_denied', { tool: name });

        interrupted = false;
        setAgentStatus('Explaining...');
        try {
          const explanation = await llmChat([{
            role: 'user',
            content: `You tried to call ${name}(${paramPreview}) but the user denied permission.\n\nExplain briefly:\n1. What you were trying to do and why\n2. Alternative approaches the user could approve\n3. What to do next\n\nBe concise — 3-4 sentences.`,
          }]);
          if (!interrupted) {
            addMessage('assistant', explanation);
            pushToWindow('assistant', explanation);
          }
        } catch {}

        setAgentStatus('');
        return;
      }

      setAgentState('tool', `Running ${name}(${paramPreview})`);
      addMessage('tool', formatToolCallForChat(name, paramPreview));
      log('INFO', 'tool_call', { tool: name, params: JSON.stringify(params).substring(0, 200) });

      // Internal critic — when model writes substantial output and has gathered facts,
      // verify the answer against the evidence before proceeding.
      if (name === 'write_file' && gatheredFacts.length >= 2) {
        const content = params.content || '';
        if (content.length > 200 && directions.length < MAX_DIRECTIONS) {
          const criticResult = await runCritic(content, gatheredFacts);
          if (criticResult) {
            // Extract a direction from the critique
            const newDirection = criticResult.substring(0, 300);

            // Check if we're going in circles
            const circling = await isCircling(newDirection);
            if (circling) {
              // We've been here before — stop oscillating, let it through
              log('INFO', 'critic_circling', { direction: newDirection });
              addMessage('system', '[critic: similar direction already tried — accepting current answer]');
            } else {
              // New direction — track it, grant extra rounds to explore the new direction
              directions.push(newDirection);
              // Reset round budget — give the model a fresh runway for the new direction
              round = Math.min(round, Math.floor(maxRounds * 0.5));
              totalToolCalls = 0;
              judgeVerdict = null;
              log('INFO', 'critic_new_direction', { direction: newDirection, attempt: String(directions.length), roundReset: String(round) });

              if (HEADLESS) {
                // Headless: auto-retry with new direction. Abort rest of batch —
                // subsequent calls (e.g. `bash` to verify the rejected write) are stale.
                addMessage('system', `[critic direction ${directions.length}/${MAX_DIRECTIONS}: ${newDirection.substring(0, 80)}]`);
                pushToWindow('assistant', `[write_file reviewed — revision needed]`);
                pushToWindow('user', renderToolResult(`Your answer has issues:\n${criticResult}\n\nPrevious directions tried:\n${directions.map((d, i) => `${i + 1}. ${d.substring(0, 100)}`).join('\n')}\n\nTake a different approach and try again.`));
                continue roundLoop;
              } else {
                // Interactive: report to user
                addMessage('system', `[critic found issues — reporting to user]`);
                pushToWindow('assistant', `[write_file reviewed — issues found]`);
                pushToWindow('user', renderToolResult(`Your answer has issues:\n${criticResult}\n\nExplain to the user what you tried, why the critic rejected it, and what directions you could take next.`));
                continue roundLoop;
              }
            }
          }
          log('INFO', 'critic_passed', { directions: String(directions.length) });
        }
      }

      // explore is a sub-investigation that may take 1-3 minutes — never background it.
      // Other tools may go background after 20s.
      // explore and web_search need long timeouts — they do real work
      const BACKGROUND_TIMEOUT = (name === 'explore' || name === 'web_search') ? 600_000 : 20_000;
      const toolStarted = Date.now();
      const toolPromise = tool.execute(params).catch(
        (err: unknown) => `Error: ${err instanceof Error ? err.message : String(err)}`,
      );

      let result: string | null = null;
      const timeoutResult = await Promise.race([
        toolPromise.then(r => { result = r; return 'done' as const; }),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), BACKGROUND_TIMEOUT)),
      ]);

      if (interrupted && immediateCancel) {
        setAgentStatus('');
        addMessage('system', 'Cancelled.');
        immediateCancel = false;
        return;
      }

      drainQueuedMessages();

      const callXml = renderToolCall({ name, params });
      const assistantTurn = textPrefix ? `${textPrefix}\n\n${callXml}` : callXml;
      pushToWindow('assistant', assistantTurn);

      if (timeoutResult === 'timeout') {
        const taskId = registerTask(name, paramPreview);
        addMessage('system', `${name} still running (>${BACKGROUND_TIMEOUT / 1000}s), continuing... [task ${taskId}]`);
        log('INFO', 'tool_backgrounded', { tool: name, taskId });

        pushToWindow('user', renderToolResult(`${name} is still running in the background (task ${taskId}). It started ${BACKGROUND_TIMEOUT / 1000}s ago. You can call the \`status\` tool to check progress, or continue with other work — the result will also arrive automatically.`));
        pushMessage('assistant', `[tool: ${name}(${paramPreview}) → backgrounded, task ${taskId}]`);

        toolPromise.then(r => {
          completeTask(taskId, r);
          saveArtifact(name, paramPreview, r);
          recordTool(name, paramPreview, r, true);
          addMessage('tool', `${formatToolCallForChat(name, `task ${taskId} completed`)}\n${formatToolResultForChat(name, r, Date.now() - toolStarted)}`);
          pushToWindow('user', renderToolResult(`Background ${name} (task ${taskId}) completed:\n${r.substring(0, 16000)}`));
          pushMessage('assistant', `[tool: ${name}(${paramPreview}) → ${r.substring(0, 150)}]`);
          log('INFO', 'tool_background_complete', { tool: name, taskId, resultLength: String(r.length) });
        }).catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          failTask(taskId, errMsg);
          log('ERROR', 'tool_background_error', { tool: name, taskId, error: errMsg });
        });

        // If a tool went background, subsequent batch calls may depend on its
        // result — bail and let the next LLM round see the bg-task message.
        continue roundLoop;
      }

      result = result!;
      saveArtifact(name, paramPreview, result);
      recordTool(name, paramPreview, result);

      let ctaJustDelivered = false;
      // One formatter for every tool: write_file gets the diff card, the rest a tag-escaped
      // gutter-block preview (raw braces in bash/grep output used to break blessed markup),
      // both closed by a ✓/✗ + duration footer.
      addMessage('tool', formatToolResultForChat(name, result, Date.now() - toolStarted));
      // Artifact tracking for the QA gate. `bash`-driven changes are caught separately by the
      // gate's git snapshot — this covers the tools whose target is known from the call itself.
      if ((name === 'write_file' || name === 'str_replace') && params.path) qaNoteTouched(params.path);
      if (name === 'write_file') {
        // Track CTA delivery — if the write target matches the CTA, mark as delivered
        if (ctaTarget && !ctaDelivered && (params.path || '').includes(ctaTarget) && (params.content || '').length > 200) {
          ctaDelivered = true;
          ctaJustDelivered = true;
          log('INFO', 'cta_delivered', { target: ctaTarget, contentLength: String((params.content || '').length) });
        }
      }

      // Fallback CTA detection: model may write the target via bash/edit_file/etc.
      // After ANY tool call, stat the target — if it exists with substantial content, mark delivered.
      if (ctaTarget && !ctaDelivered) {
        try {
          const st = statSync(ctaTarget);
          if (st.isFile() && st.size > 50) {
            ctaDelivered = true;
            ctaJustDelivered = true;
            log('INFO', 'cta_delivered', { target: ctaTarget, source: name, fileSize: String(st.size) });
          }
        } catch { /* not yet present */ }
      }

      log('INFO', 'tool_result', { tool: name, resultLength: String(result.length) });

      // The guard's note (a polling notice) rides along with the real result — the model gets the
      // information it asked for AND the rule about asking again, in the same message.
      pushToWindow('user', renderToolResult(result.substring(0, 16000) + (guard.note ?? '')));
      pushMessage('assistant', `[tool: ${name}(${paramPreview})]`);

      // CTA just delivered — tell the model it's done. This prevents the
      // "write then re-write to confirm" loop Gemma4 falls into.
      if (ctaJustDelivered) {
        pushToWindow('user', `<system>Deliverable written to ${ctaTarget}. You are done. Reply with a final one-line confirmation and STOP — do not re-write the same file.</system>`);
        log('INFO', 'cta_exit_hint', { target: ctaTarget });
      }

      // Capture facts from explore results — full result, no truncation
      if (name === 'explore' && result.length > 20) {
        // Split primary answer from auto-discovered related code
        const relatedIdx = result.indexOf('RELATED (auto-discovered');
        if (relatedIdx > 0) {
          gatheredFacts.push(result.substring(0, relatedIdx).trim());
          gatheredFacts.push('[Auto-discovered related code] ' + result.substring(relatedIdx));
        } else {
          gatheredFacts.push(result);
        }
      }

      // Judge gate — every JUDGE_INTERVAL tool calls, evaluate progress
      totalToolCalls++;
      const shouldJudge = totalToolCalls > 0 &&
        totalToolCalls % JUDGE_INTERVAL === 0 &&
        judgeVerdict?.confidence !== 'high';

      if (shouldJudge) {
        addMessage('system', '[evaluating progress...]');
        judgeVerdict = await callJudge(currentGoal, gatheredFacts);
        log('INFO', 'judge_routed', { confidence: judgeVerdict?.confidence || 'unknown', totalTools: String(totalToolCalls) });

        if (judgeVerdict?.confidence === 'mid') {
          // Promising but needs more — grant 5 more rounds then re-judge
          judgeRoundsGranted = 5;
          addMessage('system', `[progress: on track — ${judgeVerdict.reasoning}]`);
        } else if (judgeVerdict?.confidence === 'low') {
          // Stuck — don't keep burning rounds
          addMessage('system', `[progress: insufficient — ${judgeVerdict.reasoning}]`);
        }
      }

      // Count down granted rounds for mid-confidence
      if (judgeRoundsGranted > 0) judgeRoundsGranted--;
    }

    triggerSync();

    if (interrupted) {
      await handleInterrupt(userInput, round + 1);
      return;
    }
  }

  // CTA last chance — if we hit max rounds without delivering, force one final write
  if (HEADLESS && ctaTarget && !ctaDelivered && gatheredFacts.length > 0) {
    log('WARN', 'cta_force_write', { target: ctaTarget, factCount: String(gatheredFacts.length) });
    addMessage('system', `[max rounds — forcing final write to ${ctaTarget}]`);

    // Ask the model to write whatever it has
    pushToWindow('user', `<system>You have reached the maximum rounds. Write your final output to ${ctaTarget} NOW using whatever facts you have gathered. Do not explore further.</system>`);
    try {
      const finalResponse = await llmChat(buildMessages(maxRounds - 1, maxRounds));
      const finalCall = parseToolCalls(finalResponse).toolCalls[0] ?? null;
      if (finalCall && finalCall.name === 'write_file') {
        const tool = getTool('write_file');
        if (tool) {
          await tool.execute(finalCall.params);
          ctaDelivered = true;
          log('INFO', 'cta_force_delivered', { target: ctaTarget });
        }
      }
    } catch {}
  }

  log('WARN', 'max_rounds_reached', { maxRounds: String(maxRounds), ctaDelivered: String(ctaDelivered) });
  await handleMaxRounds(userInput, maxRounds);
}

/** Handoff note — ALWAYS written in headless mode on exit, regardless of reason. */
async function writeHandoff(reason: string, userInput: string, round: number, maxRounds: number): Promise<void> {
  if (!HEADLESS) return;

  const factsPreview = gatheredFacts.length > 0
    ? `\nFacts gathered (${gatheredFacts.length}):\n${gatheredFacts.map((f, i) => `  ${i + 1}. ${f.substring(0, 100)}`).join('\n')}`
    : '\nNo facts gathered.';

  const directionsPreview = directions.length > 0
    ? `\nDirections tried: ${directions.map(d => d.substring(0, 80)).join('; ')}`
    : '';

  process.stdout.write(`\n--- HANDOFF (${reason}, round ${round}/${maxRounds}) ---\n`);
  process.stdout.write(`Original prompt: ${userInput.substring(0, 200)}\n`);
  process.stdout.write(`CTA: ${ctaTarget || '(none detected)'} — ${ctaDelivered ? 'DELIVERED' : 'NOT DELIVERED'}\n`);
  process.stdout.write(`Explore calls: ${exploreCallCount}\n`);
  process.stdout.write(factsPreview + '\n');
  process.stdout.write(directionsPreview + '\n');
  process.stdout.write('--- END HANDOFF ---\n');
}

async function handleMaxRounds(userInput: string, maxRounds: number): Promise<void> {
  log('INFO', 'agent_interrupted', { round: String(maxRounds), reason: 'max_rounds' });

  await writeHandoff('max_rounds', userInput, maxRounds, maxRounds);

  if (HEADLESS) {
    try {
      const recentWork = conversationWindow
        .slice(-10)
        .map(m => `${m.role}: ${m.content.substring(0, 400)}`)
        .join('\n');

      const reflection = await llmChat([{
        role: 'user',
        content: `You were working on: "${userInput}"

You used all ${maxRounds} rounds. Here is recent context:

${recentWork}

Write a self-audit:
1. COMPLETED: What you fully finished
2. IN PROGRESS: What you started but did not finish
3. NOT STARTED: What still needs to be done
4. TO CONTINUE: The exact prompt someone should run next to continue this task

Be specific and actionable. This audit will be read by the user to decide next steps.`,
      }]);

      process.stdout.write('\n--- SELF-AUDIT ---\n');
      process.stdout.write(reflection + '\n');
      process.stdout.write('--- END AUDIT ---\n');
    } catch {
      process.stdout.write(`\n[max rounds (${maxRounds}) reached — task incomplete]\n`);
    }
    return;
  }

  await handleInterrupt(userInput, maxRounds);
}

async function handleInterrupt(userInput: string, roundsSoFar: number): Promise<void> {
  if (immediateCancel) {
    setAgentStatus('');
    addMessage('system', 'Cancelled.');
    immediateCancel = false;
    interrupted = false;
    return;
  }

  log('INFO', 'agent_interrupted', { round: String(roundsSoFar) });
  addMessage('system', 'Interrupted. Summarizing...');
  setAgentStatus('Summarizing interrupted work...');

  interrupted = false;

  try {
    const recentWork = conversationWindow
      .slice(-6)
      .map(m => `${m.role}: ${m.content.substring(0, 300)}`)
      .join('\n');

    const summary = await llmChat([{
      role: 'user',
      content: `You were working on: "${userInput}"

You completed ${roundsSoFar} tool rounds before being interrupted. Here's what happened:

${recentWork}

Provide a brief status report:
1. What you were trying to do
2. What you accomplished so far
3. What remains to be done

Be concise — 3-5 sentences max.`,
    }]);

    if (interrupted) {
      setAgentStatus('');
      addMessage('system', 'Cancelled.');
      return;
    }

    setAgentStatus('');
    addMessage('assistant', summary);
    pushToWindow('assistant', summary);
    pushMessage('assistant', summary);
    // updateSummary disabled — was hallucinating
  } catch {
    setAgentStatus('');
    addMessage('system', `Interrupted after ${roundsSoFar} rounds.`);
  }
}
