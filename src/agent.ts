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

import { formatTurnTimings, resetTurnTimings, timed } from './timing.js';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { cancelActiveThinking } from './connection.js';
import { llmChat, parseToolCalls, replyTruncated, renderToolCall, renderToolResult, activeModelId, activeContextTokens, charsPerToken, resetUsageBaseline, toolMode } from './llm/manager.js';
import { llmCall } from './llm.js';
import { webSearch } from './tools/web-search.js';
import { toolsSystemPrompt, getTool, getAllTools, cancelActiveToolExecution, modelTools } from './tools.js';
import { getSummary, pushMessage, updateSummary } from './summary.js';
import { getGoal } from './goal.js';
import { addMessage, setAgentStatus, setAgentState, setStatus, showAlert, HEADLESS, formatToolResultForChat, formatToolCallForChat, escapeBlessedTags, toItalic } from './ui.js';
import { theme } from './ui/theme.js';
import { log } from './log.js';
import { hasFinalMarker, stripFinalMarker } from './final-marker.js';
import { DEFERRAL_NUDGE, looksLikeDeferral } from './deferral.js';
import { attemptsSummary, beginEditTurn, claimsAnEditThatDoesNotExist, consecutiveMissesOn, editAttempts, noteEditAttempt } from './edit-truth.js';
import { checkPermission } from './permissions.js';
import { saveArtifact, getSessionArtifacts, readArtifact } from './artifacts.js';
import { recordPrompt, recordRaw, recordTool, recordAnswer } from './session-record.js';
// The FULL record (opt-in, unclipped) runs alongside the clipped operating record above — see
// transcript.ts for why both exist. Every call here is a no-op unless /transcribe is on.
import { transcribeAnswer, transcribePrompt, transcribeResponse, transcribeTool } from './transcript.js';
import { getConfig, getConfigIfSet, getPrompt } from './prompts.js';
import { getRules } from './rules.js';
import { isLogCoverage, isVerbose } from './modes.js';
import { pendingCorpus } from './indulge/inject.js';
import { syncSession, getSessionId } from './session-store.js';
import { registerTask, completeTask, failTask } from './tools/status.js';
import { extractSignals } from './tools/signals.js';
import { qaBeginTurn, qaChangedFiles, qaNoteTouched, qaShouldRun, qaGate, qaShowCard, shouldRunQaThisTurn, qaPreparedUnits } from './qa/index.js';
import { regenerateTouchedDiagrams } from './arduino-diagram-regen.js';
import { gateAdoption, nextBrief, implementedCount, stopAwaitingOperator } from './entangle/index.js';
import { loadTools } from './tools.js';
import { presenterPass, shouldRunPresenterThisTurn } from './presenter/index.js';
import { clearActivity } from './activity.js';
import { guardBeginTurn, guardCheck, guardDirective, guardNoteDenied } from './tool-guard.js';
import { planContextBlock, runPlan } from './plan/index.js';
import { liveTool } from './live-mirror.js';
import { exploreCacheNoteTool } from './tools/explore/cache.js';
import { setLlmPurpose } from './timing.js';

let interrupted = false;
let immediateCancel = false;
let nudgeForQueuedMessage = false;
const queuedUserInputs: string[] = [];

export function interruptAgent(): void {
  interrupted = true;
  immediateCancel = cancelActiveThinking() || cancelActiveToolExecution() || immediateCancel;
}

/**
 * Told when queued messages are absorbed into the running turn. A diff-page comment that arrives
 * mid-turn is `pending` until this fires and `working` after — without it the page would show
 * "pending" for the entire turn that is already acting on it, which is a lie about the state of the
 * work, not just a cosmetic lag.
 */
let onDrained: ((messages: string[]) => void) | null = null;

export function onQueuedMessagesDrained(fn: (messages: string[]) => void): void {
  onDrained = fn;
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
  // Single-quoted: `cwd` is whatever directory the operator launched from, and an unquoted `$(...)`
  // or quote in a path name would execute here. The `| head -1` short-circuit is what keeps this
  // cheap on a large repo (measured 0.11s over 3k C# files) — keep it.
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const hasFileWith = (dir: string, pattern: string, ext: string) => {
    try {
      const result = execSync(`grep -rl ${q(pattern)} ${q(join(cwd, dir))} --include=${q('*' + ext)} 2>/dev/null | head -1`, { timeout: 5000 }).toString().trim();
      return result.length > 0;
    } catch { return false; }
  };

  // Only widely-published frameworks are named here. A specific project's own systems and class names
  // belong in that project's `AYIN.md` (loaded as rules from the working directory) — never compiled
  // into this package, which is public and installed by strangers.
  if (exists('Assets') && exists('ProjectSettings')) {
    const parts = ['Unity C# mobile game'];
    if (hasFileWith('Assets', 'UniTask', '.cs')) parts.push('async via UniTask (CancellationTokenSource lifecycle, async state machines, MoveNext patterns)');
    if (hasFileWith('Assets', 'Zenject', '.cs')) parts.push('Zenject dependency injection');
    return parts.join('. ');
  }
  if (exists('tsconfig.json')) return 'TypeScript project';
  if (exists('package.json')) return 'Node.js project';
  if (exists('Cargo.toml')) return 'Rust project';
  if (exists('go.mod')) return 'Go project';
  if (exists('requirements.txt') || exists('pyproject.toml')) return 'Python project';
  return '';
}

/**
 * An explicit message cap, or 0 for AUTO — fill whatever context the live model actually has.
 *
 * A fixed message count is the wrong unit. Twenty messages is a third of a 65k window and an overflow
 * of a 32k one, and the preset changes under a running session, so any constant is wrong for some
 * model the operator is about to load. `buildMessages` trims by TOKENS instead; this stays only as a
 * manual override for someone who wants a short leash.
 */
function getWindowSize(): number { return getConfig('windowSize', 0); }

/** Memory backstop only — not a context bound. A session that ran for days must not grow forever. */
const WINDOW_HARD_MAX = 600;

/**
 * Characters per token — MEASURED from the live model, not assumed.
 *
 * This was a flat 3, chosen pessimistically because guessing low overruns the model and an overrun is
 * not a degraded answer but a failed call or a silently truncated prompt. The reasoning was right and
 * the number was still wrong by 40%: the server reports `prompt_eval_count` on every reply and
 * `promptChars` is known before the call, so the true ratio was measurable all along and nothing
 * measured it. On this workload it is ~4.2, which means every budget below was quietly a third smaller
 * than the window it was spending.
 *
 * `charsPerToken()` falls back to the same pessimistic 3 until three main-loop calls have confirmed a
 * plausible ratio, so the first rounds of a session behave exactly as before. See llm/manager.ts.
 */

/** Room kept for the reply and for anything the caller appends after the window. */
const RESPONSE_RESERVE_TOKENS = 2_000;

/** When the model has not resolved yet, assume the smallest window we realistically serve. */
const CONSERVATIVE_CONTEXT = 16_384;

function approxTokens(text: string): number {
  return Math.ceil(text.length / charsPerToken());
}
/**
 * How many rounds the loop may run. **Unlimited by default** — it works until it is done or the
 * operator cancels.
 *
 * The cap used to be 15 interactive, and a cap is a guess about how long a task takes made before
 * anyone knows what the task is. It cut real work mid-investigation and taught the model to rush:
 * the round counter is in the prompt, so an agent told it has three rounds left writes a conclusion
 * it has not earned. Removing the number removes both.
 *
 * This is not an infinite loop. A turn ends when the model stops calling tools and answers — the
 * cap was never what ended a normal turn, only what truncated a long one. `Ctrl+C` (`interruptAgent`)
 * remains the stop.
 *
 * Two ways to put a cap back, both deliberate:
 *   - `AYIN_MAX_ROUNDS` — what the hound uses to force a short, grep-and-answer run.
 *   - `config.maxToolRounds` in prompts.json, but ONLY if the operator actually set it. Read through
 *     `getConfigIfSet` so the shipped default cannot silently reinstate the cap this removed.
 */
export function getMaxRounds(): number {
  const capped = parseInt(process.env.AYIN_MAX_ROUNDS || '', 10);
  if (Number.isFinite(capped) && capped >= 1) return capped;
  const configured = getConfigIfSet('maxToolRounds');
  if (configured !== undefined && configured >= 1) return configured;
  return Infinity;
}

let exploreCallCount = 0;

/**
 * `AYIN_UNCHAINED=1` runs the loop WITHOUT the machinery added to compensate for a weaker setup: the
 * periodic judge and the write critic. It exists to MEASURE those, not to hide them — each was built
 * against a real failure, and several of those failures were in the tools rather than the model, so
 * whether they still earn their cost is an experiment, not an opinion.
 *
 * Read lazily rather than captured at import: a harness that flips it between runs must not need a
 * fresh process, and a test cannot set an env var before its own module graph loads.
 */
export function isUnchained(): boolean {
  const v = (process.env.AYIN_UNCHAINED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}
const gatheredFacts: string[] = [];
/**
 * Evidence from the DIRECT search/read tools, kept apart from `gatheredFacts` (which holds `explore`'s
 * curated prose, injected into the prompt whole).
 *
 * Reading code IS gathering evidence. Only `explore` results were ever recorded, so a turn that greps
 * and reads for itself was told `progress: insufficient — No facts gathered yet` after ten successful
 * calls that had already found the method, its caller and the branch at fault; the write critic, which
 * arms at >= 2 facts, never ran at all; and the judge stayed pessimistic for the whole turn. Observed on
 * a real bug-diagnosis run. These entries are short and capped — the judge needs to know WHAT was found,
 * not to re-read the files, and the accumulated-facts block in the prompt stays explore-only so this
 * costs no prompt budget.
 */
const evidenceFacts: string[] = [];
const EVIDENCE_TOOLS = new Set(['read_file', 'grep', 'find_files']);
const EVIDENCE_CHARS = 400;
const EVIDENCE_MAX = 12;
type JudgeVerdict = { confidence: 'high' | 'mid' | 'low'; reasoning: string } | null;
let judgeVerdict: JudgeVerdict = null;
const JUDGE_INTERVAL = 5;
let totalToolCalls = 0;
let judgeRoundsGranted = 0; // extra rounds granted by a judge verdict
/**
 * How many times a judge verdict may extend the run before it must wrap up.
 *
 * `low` used to TERMINATE: "Report what you have found so far — do not continue exploring." So the
 * harder the bug, the sooner the harness gave up — while `mid` (doing fine) was granted 5 more rounds.
 * Measured on a real ticket: a correct investigation was cut at round 12 having just found the faulty
 * method, and it wrote a report whose own last section was a list of what it still needed to read.
 *
 * Low confidence means KEEP GOING, with the judge's own account of what is missing. Stopping is the
 * round cap's job — but an unbounded "keep going" is its own failure, so extensions are counted and the
 * wrap-up directive fires when they run out.
 */
const MAX_JUDGE_EXTENSIONS = 4;
let judgeExtensions = 0;

/** Reset per-turn counters on new user turn */
function resetCounters(): void {
  exploreCallCount = 0;
  if (isUnchained()) log('INFO', 'unchained', { judge: 'off', critic: 'off' });
  guardBeginTurn(); // repeat/deny/poll budget is per turn — see tool-guard.ts
  gatheredFacts.length = 0;
  evidenceFacts.length = 0;
  judgeVerdict = null;
  totalToolCalls = 0;
  judgeRoundsGranted = 0;
  judgeExtensions = 0;
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
    const peerPrompt = getPrompt('criticPeerAnalysis', {
      SIGNALS: signalsText,
      FACTS: factsText.substring(0, 5000),
    });

    setLlmPurpose('critic · peer review');
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
      getPrompt('criticArbiterRating', {
        PERSONA: persona,
        EVIDENCE: factsText.substring(0, 3000),
        SIGNALS: signalsText,
        EXPLANATION: explanation.substring(0, 1500),
      });

    const [originalResponse, peerResponse] = await Promise.all([
      llmChat([{ role: 'user', content: ratePrompt(
        getPrompt('criticArbiterPersona'),
        proposedAnswer
      ) }]),
      llmChat([{ role: 'user', content: ratePrompt(
        getPrompt('criticArbiterPersona'),
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

  const prompt = getPrompt('criticCircleCheck', {
    PREVIOUS_DIRECTIONS: directions.map((d, i) => `${i + 1}. ${d.substring(0, 150)}`).join('\n'),
    NEW_DIRECTION: newDirection.substring(0, 150),
  });

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
  const prompt = getPrompt('judgeProgress', {
    TASK: task.split('\n')[0],
    FACTS: factsText,
  });

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

/**
 * Fit a tool result into the window WITHOUT lying about it.
 *
 * It used to be `result.substring(0, 16000)`: a silent head-clip. Two ways that misleads — the model is
 * never told anything was dropped, and for the results that actually overflow (a build log, a test run,
 * a long diff) the part it drops is the END, which is exactly where the compiler prints the error. The
 * head is kept for context, the tail because that is where the answer usually is, and the seam says how
 * much went missing and how to get it.
 */
/**
 * How much of ONE tool result the window keeps.
 *
 * MEASURED, not chosen by feel. The four verbatim tail messages dominate the prompt, so this number
 * decides how much HISTORY fits beside them. At 16k, a 32k-context model held 9 messages of history;
 * at 8k it holds 23. Halving the clip more than doubles the history on every preset:
 *
 *     clip    muse@32k   gemma@40k   gemma@65k
 *     16000          9          20          53
 *      8000         23          33          67
 *      4000         30          40          74
 *
 * The returns flatten below ~8k while the cost — a result too short to carry its own answer — keeps
 * rising, so this is the knee rather than the minimum. 8k is still ~200 lines of grep output, and the
 * clip keeps both ends (errors land at the end). Operators who want the old behaviour can raise
 * `toolResultChars`.
 */
const WINDOW_RESULT_CHARS_DEFAULT = 8_000;
function windowResultChars(): number { return getConfig('toolResultChars', WINDOW_RESULT_CHARS_DEFAULT); }
export function clipForWindow(text: string, limit = windowResultChars()): string {
  if (text.length <= limit) return text;
  const marker = (n: number): string =>
    `\n\n… [${n.toLocaleString()} characters omitted from the MIDDLE of this result — the end is kept because errors land there. ` +
    `Re-run narrowed, or redirect to a file and grep it, if you need the omitted part.] …\n\n`;
  const head = Math.floor(limit * 0.55);
  const tail = Math.max(0, limit - head - marker(0).length);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}${marker(omitted)}${text.slice(text.length - tail)}`;
}

function pushToWindow(role: string, content: string): void {
  conversationWindow.push({ role, content });
  // NO CONTEXT DECISION HERE. Evicting on push threw history away before anyone knew whether it fit —
  // on a 65k model, two thirds of the window sat unused while the original question was already gone.
  // What survives is decided at build time, against the model actually loaded. This bound is memory.
  const cap = getWindowSize() > 0 ? getWindowSize() : WINDOW_HARD_MAX;
  while (conversationWindow.length > cap) {
    conversationWindow.shift();
  }
}

/**
 * Record a turn the AGENT LOOP never ran — a tool invoked directly from its slash command.
 *
 * `conversationWindow` is what the model sees as "what we have been doing". A slash-invoked connector
 * answers on screen without ever entering the loop, so the next ordinary question ("which of those is
 * blocked?") reaches a model that never saw the tickets and answers about nothing. Appended as a normal
 * user/assistant pair, clipped like any tool result — a whole sprint dump is not worth the window.
 */
export function recordSlashTurn(userInput: string, answer: string): void {
  pushToWindow('user', userInput);
  pushToWindow('assistant', clipForWindow(answer));
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

/**
 * Assemble the prompt for one round: a STABLE system message, the conversation, then the volatile
 * block. Exported so `tool/check-gates.mjs` can assert the invariant this shape exists for — the
 * system message must be byte-identical across rounds, or every round re-prefills the whole window.
 */


/**
 * A finished reply starts with `$`. Leading whitespace is tolerated because a model that opens with a
 * newline meant the same thing; anything else before it is not the marker.
 */
/** Refusals of an unmarked, tool-less turn before it is accepted anyway. Three clears the reflex. */
const MAX_CONTINUE_NUDGES = 1;

/**
 * SOME MODELS DO NOT SPEAK THIS PROTOCOL, and punishing them for it costs more than it saves.
 *
 * The `$` convention is enforced because a model once returned a to-do list as an answer and six files
 * went unwritten. But it assumes the model follows the convention at all, and gemma — the model the
 * convention was written for, reached through the resource provider — sometimes does not. Read from a real
 * session log: one `llm_call`, one `continue_nudge`, one more `llm_call` whose reply ARGUED with the
 * harness ("since you have signaled that I should continue... I will perform a scan of the current working
 * directory") and then did exactly that. One nudge was enough to produce busywork.
 *
 * So the nudge is now spent ONCE per turn, and once a session has proven the model never marks its
 * replies, it stops entirely: two unmarked finals with no marker ever produced is evidence about the
 * MODEL, not about this turn. A protocol one side does not implement is not a protocol, and the harness
 * stops pretending otherwise instead of burning rounds on it.
 */
let markerEverSeen = false;
let unmarkedFinals = 0;
const GIVE_UP_ON_MARKER_AFTER = 2;

/** Whether the marker convention is worth enforcing on this session's model. */
function markerWorthEnforcing(): boolean {
  return markerEverSeen || unmarkedFinals < GIVE_UP_ON_MARKER_AFTER;
}

/**
 * CONSECUTIVE nudges without progress, not nudges in total.
 *
 * The cap exists so a model that cannot advance does not spin. A model that IS advancing — a file landed
 * since the last nudge — is not spinning, and capping it by total count is what stopped a nine-type task
 * at two files and round 81 with every nudge spent. Progress resets the counter; genuine stalling still
 * ends the turn after three.
 */
const MAX_STALLED_NUDGES = 3;

export function buildMessages(round: number, maxRounds: number): Message[] {
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
  // "Ayin, running on qwen3-coder:30b"; without it, it confabulates a vendor.
  const servedModel = activeModelId();
  if (servedModel) {
    const identity =
      // Names the MODEL and nothing else. It used to name the author's own backend, which every install
      // then recited on every turn — "what model are you" is the first thing anyone asks a new agent, and
      // a stranger would have been told about a service they do not run.
      `You are running on the local model "${servedModel}" — you are ` +
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

  // Operator modes. Both are stable for the whole turn — they change only when a command is typed —
  // so they live above the prefix boundary and cost one cache invalidation per toggle, not per round.
  // Brevity is the DEFAULT and `/verbose` opts out of it; log coverage is opt-in via `/logcover`.
  if (!isVerbose()) {
    systemContent += `\n\n${getPrompt('brevity')}`;
  }
  if (isLogCoverage()) {
    systemContent += `\n\n${getPrompt('logCoverage')}`;
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

  /**
   * THE PREFIX MUST NOT MOVE.
   *
   * Everything above this line is byte-identical for every round of the session: tools, identity,
   * detected expertise, rules, session goal. Everything below CHANGES between rounds — the round
   * counter, gathered facts, blocked calls, the judge's verdict, the CTA reminder — and it used to be
   * appended to the SYSTEM message, at the very front of the prompt.
   *
   * A server caches a KV *prefix*. Change byte 300 of a 14k-token prompt and every token after it is
   * re-computed, so each round paid full prefill for the whole window again. Measured on one bug
   * investigation: ~15s per round while the window was small, ~104s per round once it filled, with
   * the GPU otherwise idle and the model fully resident.
   *
   * So the volatile material rides at the END, after the conversation, where new tokens are the only
   * new work. It is sent as a `user` turn rather than a second system message because only the first
   * system message is honoured reliably across chat templates.
   */
  let volatile = '';
  if (currentGoal) {
    volatile += `\n\nCurrent task: ${currentGoal}`;
  }

  // Auto-research grounding for this turn (web search ran before the base call, per the trigger).
  // A rolling summary carried in from a resumed session — prior context the window can't hold.
  if (summary.summary) {
    volatile += `\n\nContext from earlier in this session (restored):\n${summary.summary}`;
  }

  // A plan produced before this turn (plan mode) — the agent's marching orders for a big request.
  if (planContext) {
    volatile += `\n\n${planContext}`;
  }

  if (diagramContext) {
    volatile += `\n\n${diagramContext}`;
  }

  if (researchContext) {
    volatile += `\n\n${researchContext}`;
  }

  // Programmatic fact tracker — no LLM, just concatenated explore results.
  if (gatheredFacts.length > 0) {
    volatile += `\n\nFacts gathered so far (${gatheredFacts.length} explore calls):\n`;
    gatheredFacts.forEach((fact, i) => {
      volatile += `${i + 1}. ${fact}\n\n`;
    });
  }

  // What has already run. Same reasoning as the blocked list below, applied to the calls that
  // SUCCEEDED — a result that scrolled out of the window is indistinguishable, from the model's side,
  // from a call it never made.
  const ledger = renderCallLedger();
  if (ledger) {
    volatile += `\n\n${ledger}`;
  }

  // Blocked / denied calls — a refusal that only lives in a tool_response scrolls out of the window
  // and the model tries again. Here it is present every round for as long as the turn lasts.
  const blockedDirective = guardDirective();
  if (blockedDirective) {
    volatile += `\n\n<blocked-calls>\n${blockedDirective}\n</blocked-calls>`;
  }

  // Direction history — what the critic rejected, so the model doesn't repeat
  if (directions.length > 0) {
    volatile += `\n\nPrevious approaches that were rejected by the internal reviewer:\n`;
    directions.forEach((d, i) => {
      volatile += `${i + 1}. ${d}\n`;
    });
    volatile += `Do not repeat these approaches. Try a different angle.\n`;
  }

  // Judge verdict — routes the agent's next action
  if (judgeVerdict?.confidence === 'high') {
    volatile += `\n\nYour gathered facts are sufficient to produce a complete answer. Write your final output now.`;
  } else if (judgeVerdict && judgeExtensions >= MAX_JUDGE_EXTENSIONS && judgeRoundsGranted <= 0) {
    // The budget is spent. NOW wrapping up is right — and say why, so a partial answer is labelled as
    // partial rather than presented as a conclusion.
    volatile += `\n\nYou are out of investigation budget. Write up what you have, and say plainly which parts are unconfirmed. What was still missing: ${judgeVerdict.reasoning}`;
  } else if (judgeVerdict?.confidence === 'low') {
    // Not "stop" — "here is what you are missing, go and get it".
    volatile += `\n\nProgress check: ${judgeVerdict.reasoning}\nThat is what is still missing — go and read it. Do not write a final answer yet.`;
  }

  // What the corpus knows about THIS prompt. In the volatile block, never the prefix: it changes
  // every turn by definition, and the system message must stay byte-identical for the KV cache.
  const corpus = pendingCorpus();
  if (corpus) {
    volatile += `\n\n<corpus>\n${corpus}\n</corpus>`;
  }

  // CTA tracking — remind the model of its deliverable if overdue
  const remaining = maxRounds - round - 1;
  if (ctaTarget && !ctaDelivered && round >= 5) {
    volatile += `\n\nYour deliverable: write the final output to ${ctaTarget}. You have not done this yet.`;
  }

  // With no cap there is no denominator and no deadline to announce. Stating a bare round number is
  // still worth it — it is how the model knows it is mid-turn — but every pressure line is gone:
  // "3 rounds left" is exactly the nudge that bought rushed conclusions, and it cannot be true here.
  if (!Number.isFinite(maxRounds)) {
    volatile += `\n\n[Round ${round + 1}. Take the rounds you need; stop when the work is done.]`;
  } else if (remaining <= 3) {
    volatile += `\n\n[URGENT: Round ${round + 1}/${maxRounds}. Only ${remaining} round(s) left. Write your final answer now.]`;
  } else if (round >= Math.floor(maxRounds * 0.75)) {
    volatile += `\n\n[Round ${round + 1}/${maxRounds}. Past 75% — converge toward your conclusion.]`;
  } else {
    volatile += `\n\n[Round ${round + 1}/${maxRounds}.]`;
  }

  messages.push({ role: 'system', content: systemContent });
  const volatileTurn = volatile.trim()
    ? { role: 'user', content: `<session-context>\n${volatile.trim()}\n</session-context>` }
    : null;

  // Compression is ON DEMAND, not on a schedule. See `compressOldest`.
  const fixed = approxTokens(systemContent) + approxTokens(volatileTurn?.content ?? '');
  const masked = compressOldest(conversationWindow, fixed);
  for (const msg of conversationWindow) messages.push(msg);
  if (volatileTurn) messages.push(volatileTurn);
  logCoverage({
    round,
    system: systemContent,
    history: messages.slice(1, volatileTurn ? messages.length - 1 : messages.length),
    volatile: volatileTurn?.content ?? '',
    maskedCount: masked.count,
    maskedCharsDropped: masked.dropped,
  });
  return trimToContext(messages);
}

/**
 * WHAT THE PROMPT IS MADE OF, and how much of the window went unused.
 *
 * `llm_usage` reports the prompt's exact size AFTER the call, which answers "how big" and nothing
 * about "of what". Every context question worth debugging is a composition question — whether the
 * fixed prefix is crowding out history, whether the masking is destroying evidence mid-turn, whether
 * the headroom that is left is large enough that a cap firing at all is a bug. None of that was
 * visible: a session that dropped from 21.4k to 13.8k tokens across ten rounds, with 42,000 tokens
 * spare, produced no log line at all, because nothing here logs a subtraction.
 *
 * `dropped` is the load-bearing number. It is chars destroyed IN THE WINDOW, permanently — the
 * masking writes its truncation back — so a rising total is evidence the agent is being starved
 * while the window is empty, and it is the one number no downstream event can reconstruct.
 *
 * TOKENS HERE ARE ESTIMATES (chars ÷ 3, pessimistic, the same arithmetic `trimToContext` spends the
 * budget with) and are labelled `est`. Joining this to the `llm_usage` for the same round gives the
 * exact total beside this breakdown, which is the whole reason `round` is on both.
 */
function logCoverage(c: {
  round: number;
  system: string;
  history: Message[];
  volatile: string;
  maskedCount: number;
  maskedCharsDropped: number;
}): void {
  const sys = approxTokens(c.system);
  const hist = c.history.reduce((n, m) => n + approxTokens(m.content), 0);
  const vol = approxTokens(c.volatile);
  const ctx = activeContextTokens();
  const used = sys + hist + vol;
  log('INFO', 'prompt_coverage', {
    round: String(c.round + 1),
    estTokens: String(used),
    prefixEst: String(sys),
    historyEst: String(hist),
    volatileEst: String(vol),
    msgs: String(c.history.length),
    masked: String(c.maskedCount),
    dropped: String(c.maskedCharsDropped),
    ctxTokens: String(ctx || 0),
    // Unknown window → no headroom claim. A number invented here would be consulted and wrong,
    // which is the failure the session meter already made once.
    headroomEst: ctx ? String(ctx - RESPONSE_RESERVE_TOKENS - used) : '',
    usedPct: ctx ? (100 * used / ctx).toFixed(1) : '',
  });
}

/**
 * Never compress the four most recent messages. A floor, not a policy — what actually decides how much
 * history stays verbatim is the budget below, which stops the moment the prompt fits.
 */
const VERBATIM_TAIL = 4;

/** What one compressed tool result keeps. Only ever applied to a result the budget cannot afford. */
const COMPRESS_TO_CHARS = 2_000;

/**
 * COMPRESS ONLY WHEN THE WINDOW IS ACTUALLY FULL — and it almost never is.
 *
 * This used to compress every `<tool_response>` older than the four most recent, down to 2,000
 * characters, permanently, on every round. It fired on MESSAGE AGE and asked nothing about the window,
 * which on a 65k model meant the agent was starved while the window sat empty. Measured on one real
 * session: the prompt climbed to 21.4k tokens by round 5, dropped to 15.7k at round 6 as the first
 * results aged out, and sat near 13.8k for ten more rounds — 36 tool calls' worth of evidence being
 * shredded with 42,000 tokens of headroom unused. The agent then re-ran greps whose answers it had
 * already been given and thrown away.
 *
 * So the trigger is the BUDGET. Nothing is compressed until the prompt passes `COMPRESS_ABOVE` of it,
 * and then only the oldest results, only until the prompt fits again. On a 65k window that threshold is
 * ~47k tokens — above every interactive round this machine has ever produced, so in practice full
 * history now reaches the model and this function does nothing.
 *
 * WRITTEN BACK, STILL. Compression stays one-way: a message compressed this round must arrive
 * compressed next round, or every token after it moves and the server re-prefills the whole prompt.
 * Demand-driven compression is strictly kinder to that cache than the old rule, which re-compressed a
 * newly-aged message every round or two and churned the prefix each time it did.
 *
 * The order is deliberate: compress, THEN let `trimToContext` evict. Losing the middle of an old result
 * is a smaller loss than losing the whole message, so eviction must be the last resort and not the
 * first thing the budget reaches for.
 */
const COMPRESS_ABOVE = 0.75;
const COMPRESS_UNTIL = 0.6;

export function compressOldest(window: Message[], fixedTokens: number): { count: number; dropped: number } {
  const ctx = activeContextTokens() || CONSERVATIVE_CONTEXT;
  const budget = ctx - RESPONSE_RESERVE_TOKENS;
  let total = fixedTokens + window.reduce((n, m) => n + approxTokens(m.content), 0);
  if (budget <= 0 || total <= budget * COMPRESS_ABOVE) return { count: 0, dropped: 0 };

  const target = budget * COMPRESS_UNTIL;
  const last = window.length - VERBATIM_TAIL;
  let count = 0;
  let dropped = 0;
  for (let i = 0; i < last && total > target; i++) {
    const msg = window[i];
    if (msg.role !== 'user' || !msg.content.startsWith('<tool_response>')) continue;
    if (msg.content.length <= COMPRESS_TO_CHARS) continue;
    const cut = msg.content.lastIndexOf('\n', COMPRESS_TO_CHARS);
    const kept = cut > 100 ? msg.content.slice(0, cut) : msg.content.slice(0, COMPRESS_TO_CHARS);
    const was = msg.content.length;
    const before = approxTokens(msg.content);
    msg.content = `${kept}\n\u2026 [older result compressed \u2014 the window was full. Re-run narrowed if you need the rest.]\n</tool_response>`;
    total -= before - approxTokens(msg.content);
    dropped += was - msg.content.length;
    count++;
  }
  if (count) {
    log('INFO', 'history_compressed', {
      results: String(count), droppedChars: String(dropped),
      estTokens: String(Math.round(total)), ctxTokens: String(ctx),
      thresholdTokens: String(Math.round(budget * COMPRESS_ABOVE)),
    });
  }
  return { count, dropped };
}

/**
 * Drop the OLDEST history until the prompt fits the model actually loaded.
 *
 * This replaces a fixed message count, which was the wrong unit in both directions: twenty messages is
 * a third of a 65k window and an overflow of a 32k one, and the preset changes under a running session
 * — the operator swapped gemma@65k for muse@32k mid-work more than once today. A constant chosen for
 * either is wrong for the other, and being wrong upward is not a worse answer, it is a failed call.
 *
 * Two things are never dropped: the SYSTEM message, which carries the tools and the identity and must
 * stay byte-identical for the KV cache, and the volatile turn at the end, which is this round's actual
 * instruction. Everything between them is history, newest first in value, so eviction runs from the
 * front.
 */
export function trimToContext(messages: Message[]): Message[] {
  const ctx = activeContextTokens() || CONSERVATIVE_CONTEXT;
  const budget = ctx - RESPONSE_RESERVE_TOKENS;
  if (budget <= 0) return messages;

  const total = (ms: Message[]): number => ms.reduce((n, m) => n + approxTokens(m.content), 0);
  if (total(messages) <= budget) return messages;

  // EVICT IN ONE BITE, NOT ONE MESSAGE PER ROUND — the difference is a 27-SECOND ROUND vs a
  // half-second one, and it is the whole reason a long session felt like it had seized up.
  //
  // The server caches the KV state of the prompt PREFIX and reuses it when the next prompt starts
  // with the same tokens. Dropping the oldest message changes the sequence immediately after the
  // system message, so nothing past it matches and the ENTIRE prompt is processed again from
  // scratch. Trimming to exactly the budget guarantees the next round is over budget again — the
  // window only grows — so it evicts again, and again, and every single round pays a full reprocess.
  //
  // Measured through the gateway on this hardware: 920 prompt tokens → 0.56s, 17,594 → 26.9s. Once a
  // session filled the window (a ticket dump does it in one tool call), every round cost ~27s and the
  // operator saw an agent that "holds for more than a minute" while doing nothing visible.
  //
  // So overshoot deliberately: come down to EVICT_TO of the budget and leave headroom, and the next
  // several rounds append to an unchanged prefix and hit the cache. Same total work evicted, paid
  // once instead of every round. The cost is history dropped slightly earlier than strictly forced —
  // cheap, since it is the oldest history, and the alternative is paying for it in wall-clock forever.
  const EVICT_TO = 0.7;
  const target = Math.floor(budget * EVICT_TO);

  // Index 0 is the system message; the last entry may be the volatile turn. Evict between them.
  const head = messages[0];
  const rest = messages.slice(1);
  const before = approxTokens(head.content) + total(rest);
  let dropped = 0;
  while (rest.length > 1 && approxTokens(head.content) + total(rest) > target) {
    rest.shift();
    dropped++;
  }
  if (dropped) {
    log('INFO', 'window_trimmed', {
      dropped: String(dropped),
      kept: String(rest.length),
      ctxTokens: String(ctx),
      estTokens: String(approxTokens(head.content) + total(rest)),
      wasTokens: String(before),
      targetTokens: String(target),
    });
  }
  return [head, ...rest];
}

function drainQueuedMessages(): number {
  const taken: string[] = [];
  while (queuedUserInputs.length > 0) {
    const message = queuedUserInputs.shift()!;
    currentGoal = message;
    pushToWindow('user', message);
    pushMessage('user', message);
    taken.push(message);
  }
  if (taken.length > 0) {
    log('INFO', 'agent_messages_drained', { count: String(taken.length) });
    // Never let a listener's failure break the turn that was doing real work.
    if (onDrained) {
      try { onDrained(taken); }
      catch (e) { log('WARN', 'drain_listener_failed', { error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  return taken.length;
}

/** Truncate goal to a single short line for the summarizer — avoids eating the whole summary budget. */
function summarizableGoal(): string {
  const first = currentGoal.split('\n')[0].trim();
  return first.length > 120 ? first.substring(0, 117) + '...' : first;
}

/** Fire-and-forget checkpoint write to the local session store — only when a session is active */
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
// (the operator's stack, if they configured one). Opt out with AYIN_RESEARCH=0.
const RESEARCH_TRIGGER = /(grounded|citing|citation|research)/i;
/**
 * The operator's stack + hardware, used to tailor grounded answers. Ships EMPTY: it is
 * environment-specific, so it comes from the `SYSTEM_INFO` env var (or an `AYIN.md` rule file for
 * anything longer). A baked default published one person's lab inventory to every installer of this
 * package — and was wrong for all of them, which made the feature quietly worse rather than better.
 */
function systemInfo(): string {
  return (process.env.SYSTEM_INFO ?? '').trim();
}
/** What the prompts interpolate — never an empty label, never someone else's hardware. */
function stackVar(): string {
  return systemInfo() || 'unspecified';
}

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
        getPrompt('researchQuery', { REQUEST: userInput, STACK: stackVar() }),
      )).trim().split('\n')[0].replace(/^["']|["']$/g, '').slice(0, 200);
      if (q.length > 3) query = q;
    } catch { /* formulation failed — fall back to the raw prompt as the query */ }
    // 2) web search (SearXNG → DuckDuckGo) → real hits + sources.
    const results = await webSearch(query);
    // 3) pre-prompt the base call: grounded, scientific→household, tailored to the user's stack.
    researchContext = getPrompt('researchGrounding', {
      QUERY: query,
      RESULTS: results,
      STACK: stackVar(),
    });
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
    diagramContext = getPrompt('diagramGrounding', {
      DIAGRAM: formatDiagramResult(r),
      FILE: String(r.file),
    });
    addMessage('system', `Diagram: ${r.file}${r.image ? ` (rendered ${r.image})` : ''}`);
    log('INFO', 'auto_diagram', { file: r.file ?? '', kind: r.kind ?? '', rounds: String(r.rounds) });
  } catch (err) {
    log('WARN', 'auto_diagram_error', { error: err instanceof Error ? err.message : String(err) });
    diagramContext = '';
  } finally {
    setAgentStatus('');
  }
}

/**
 * One turn, with its phases measured.
 *
 * The tally is printed from a `finally` so an INTERRUPTED or FAILED turn still says where its time
 * went — those are the turns most worth measuring, and the ones a wrapper around the happy path
 * loses. It stays silent unless the turn as a whole crossed the long-operation threshold: a marker
 * that fires every turn is a marker nobody reads.
 */
export async function runAgent(userInput: string): Promise<void> {
  resetTurnTimings();
  // A new turn is not "the last prompt plus a tool result", so the growth arithmetic starts over —
  // otherwise the first call of turn two would price the whole new prompt as something a tool added.
  resetUsageBaseline();
  try {
    await runAgentTurn(userInput);
  } finally {
    const tally = formatTurnTimings();
    if (tally) addMessage('system', tally);
  }
}

/** How often the loop-breaker fires for one tool within a turn. */
const LOOP_NUDGE_EVERY = 8;

/**
 * WHAT HAS ALREADY BEEN RUN THIS TURN — in the prompt, every round, from the first call to the last.
 *
 * Nothing carried this. `recordTool` and `transcribeTool` both write to disk, for the operator and the
 * QA gate, and are never read back to the model. `gatheredFacts` carries explore results only;
 * `guardDirective` carries the calls that were BLOCKED. The set of calls that ran and worked was
 * nowhere, so a turn's own history was the only record — and history is exactly what gets compressed
 * and evicted. Measured: a 36-call turn re-grepping identifiers whose results it had already been
 * given, because the message carrying them had been cut to 2,000 characters eleven rounds earlier.
 *
 * A LEDGER IS NOT A TRANSCRIPT. One line per call — the call, and enough of the outcome to know
 * whether asking again could possibly help. It survives every compression and eviction below because
 * it is rebuilt into the volatile block each round rather than living in the history at all, which is
 * the whole point: the cheapest thing in this file, and the only one that cannot be thrown away.
 */
interface RanCall { tool: string; params: string; ok: boolean; gist: string }
const callLedger: RanCall[] = [];

/** Cleared at the start of every turn. Exported for `check:window`, which cannot run a turn. */
export function resetCallLedger(): void { callLedger.length = 0; }

/**
 * Lines rendered. The full ledger is kept — only the RENDER is bounded, and by the tail, because "what
 * did I just try" is asked far more often than "what did I try first". A 300-call turn would otherwise
 * put 13k tokens of its own bookkeeping in front of the model, which is the failure this fixes in
 * reverse.
 */
const LEDGER_LINES = 60;
/** Enough of an outcome to decide whether a repeat could help. Not enough to be a second copy of it. */
const LEDGER_GIST_CHARS = 100;

export function noteRanCall(tool: string, params: string, ok: boolean, outcome: string): void {
  const gist = outcome.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  callLedger.push({
    tool, params, ok,
    gist: gist.length > LEDGER_GIST_CHARS ? `${gist.slice(0, LEDGER_GIST_CHARS - 1)}\u2026` : gist,
  });
}

/** The ledger as prompt text, or '' when nothing has run yet. Exported for `check:window`. */
export function renderCallLedger(): string {
  if (callLedger.length === 0) return '';
  const shown = callLedger.slice(-LEDGER_LINES);
  const omitted = callLedger.length - shown.length;
  const lines = shown.map((c, i) => {
    const n = omitted + i + 1;
    return `${n}. ${c.tool}(${c.params}) \u2192 ${c.ok ? '' : 'FAILED: '}${c.gist || (c.ok ? 'ok' : 'no detail')}`;
  });
  const head = omitted > 0 ? [`[${omitted} earlier call(s) not listed]`, ...lines] : lines;
  return getPrompt('callLedger', { CALLS: head.join('\n') });
}

async function runAgentTurn(userInput: string): Promise<void> {
  // Per TURN, not per session: a second question legitimately searches again from scratch.
  const toolUseCounts = new Map<string, number>();
  resetCallLedger();
  // Discovery, once. Idempotent, so every entry point can insist rather than assume.
  await loadTools();
  currentGoal = userInput;
  recordPrompt(userInput); // consolidated per-session record (prompts + tools + answers)
  transcribePrompt(userInput); // full transcript (no-op unless /transcribe)
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
  // The edit ledger shares the QA gate's turn boundary but NOT its enable check: the fabrication
  // guard it feeds is unconditional, and QA is session-off by default. See edit-truth.ts.
  beginEditTurn();
  // No gate label may outlive the turn it described — a status bar still claiming `▣ QA 2/3` after
  // the answer landed is worse than no indicator at all.
  clearActivity();

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
  /** How many times a text-only turn may be refused because the entangled design is unsatisfied. */
  let adoptionNudges = 0;
  let continueNudges = 0;
  let deferralNudges = 0;
  let unwrittenClaimNudges = 0;
  // Did this turn actually DO anything? A turn that ran a tool has produced something the operator
  // did not have; its closing "you should also check X" is a caveat, not a dodge.
  let toolsRunThisTurn = 0;
  const touchedAnythingThisTurn = (): boolean => toolsRunThisTurn > 0;
  /** How much the design had absorbed at the last nudge, so progress can clear the stall counter. */
  let lastImplemented = -1;
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
      // Timed, and loudly. A ten-minute round used to be indistinguishable from a hung one: the
      // status line says "Thinking…" for a model call, a tool run and a QA pass alike, so the only
      // evidence was that ayin was slow — and "the model is slow" was the wrong answer three times in
      // one day. Measured live during one of them: the GPU sat at 0% and the gateway queue was EMPTY
      // while ayin had been "generating" for 10m38s. Nothing was slow. Nothing was running.
      // Named, not wrapped: llmChat times itself now, so wrapping here would count the round twice.
      setLlmPurpose(`round ${round + 1} · ${activeModelId() || 'model'}`);
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
      // Also the bottom row: a failed model call used to scroll away behind the next thing printed,
      // which is when you most need it still on screen.
      showAlert('error', `LLM call failed — ${msg}`);
      log('ERROR', 'llm_error', { error: msg });
      return;
    }

    // Postprocessing (ayin layer): parsing tool calls out of the raw model text. Usually
    // instant, but a malformed/huge response makes this visible — surface it honestly.
    setStatus({ llm: { phase: 'postprocessing', detail: 'ayin' } });
    const parsed = parseToolCalls(response);
    setStatus({ llm: null });
    /**
     * THE MARKER IS A SIGNAL TO THE HARNESS, NEVER TEXT FOR THE OPERATOR — so it is removed HERE, once,
     * before anything can print it.
     *
     * It used to be stripped much further down, from `response_`, which is the copy that goes into the
     * record and the window. But the reply is PRINTED from `parsed.text` in six places, the earliest of
     * them (pre-tool reasoning, just below) long before that point — so the `$` was shown to the operator
     * every time. Invisible while models put it first, where it reads as a prompt character; obvious the
     * moment gemma4 started appending it and it turned up at the end of finished answers.
     *
     * `response` is deliberately left untouched: the marker test below reads the RAW reply, and the
     * transcript above has already recorded the raw text, which is the point of the transcript.
     */
    parsed.text = stripFinalMarker(parsed.text ?? '');
    let hasToolCalls = parsed.toolCalls.length > 0;

    /**
     * A CUT-OFF TOOL CALL IS NOT AN ANSWER.
     *
     * A reply that opens a call and never closes it parses to zero calls, which is exactly what a
     * final answer parses to — so ayin printed half a `str_replace` at the operator as if it were
     * prose, edited nothing, and ended the turn. Reported by the operator, and the worst kind of
     * failure: it looks like the agent decided to stop.
     *
     * Ask for it again, once per round, saying what happened. The generation hit a ceiling, so the
     * instruction is to make the call SMALLER rather than to repeat it verbatim.
     */
    if (!hasToolCalls && replyTruncated(response)) {
      log('WARN', 'reply_truncated_mid_tool_call', { chars: String(response.length) });
      addMessage('system', `[the model's reply was cut off mid tool call (${response.length} chars) — asking again]`);
      pushToWindow('assistant', '[reply cut off]');
      pushToWindow('user', renderToolResult(
        'Your last reply ended in the middle of a tool call, so nothing ran and the closing tag never '
        + 'arrived. The generation hit a length limit. Send the call again, smaller: edit one region at '
        + 'a time, or write the file in parts.'));
      continue;
    }
    hasToolCalls = parsed.toolCalls.length > 0;
    // The RAW model text, before any parsing strips the tool-call markup — this is the thing you need
    // when the question is "why did it call that", and it is the first thing every other record drops.
    transcribeResponse(round, activeModelId(), response, parsed.toolCalls.length);

    // For tool-call rounds: print pre-tool reasoning immediately (both modes).
    // Marked INTERIM: this is prose on the way to a tool call, and the TUI sets it a tab in and paler so
    // a turn with six calls does not put seven answer-looking paragraphs on screen (ui/widgets/chat.ts).
    if (hasToolCalls && parsed.text) {
      addMessage('assistant', parsed.text, { interim: true });
      lastPrintedText = parsed.text;
    }

    // Sync immediately after every assistant message so bad replies are captured
    // before any tool runs. The syncing flag prevents stacking.
    triggerSync();

    if (!hasToolCalls) {
      // ── IS THIS AN ANSWER, OR IS IT MID-WORK? ──────────────────────────
      //
      // The loop used to answer that by asking whether a tool was called, which cannot tell "here is my
      // finished report" from "here is my plan for the remaining six types". Measured: a 9-type assembly
      // returned 3 types and a to-do list at round 16 of 1000, and the operator got a to-do list where a
      // result should have been. No amount of asking the model to keep going fixes it — the model's turn
      // WAS useful, it just was not final.
      //
      // So the model declares its own intent with one character: a finished reply starts with `$`. A
      // mid-work turn carries tool calls and no marker. Neither → it is mid-thought, and it is asked to
      // continue. The marker is stripped before anyone sees it.
      //
      // Why this works where "please continue" does not: compliance is MECHANICALLY CHECKABLE. The
      // harness does not hope the convention is followed, it detects the absence and reacts — and the
      // reaction re-states the rule, so drifting out of the convention is self-correcting. The default is
      // also the safe one: forgetting the marker costs one round, while the failure it replaces cost six
      // unwritten files.
      if (hasFinalMarker(response)) markerEverSeen = true;
      else unmarkedFinals++;
      if (!hasFinalMarker(response) && markerWorthEnforcing() && !stopAwaitingOperator()
          && continueNudges < MAX_CONTINUE_NUDGES) {
        continueNudges++;
        // A reply with no tool call AND no marker is one the harness could not classify. Keeping it
        // is how "why did it stop there" is answerable tomorrow.
        recordRaw(round, 'no tool call and no final marker', response);
        log('INFO', 'continue_nudge', {
          nudge: String(continueNudges), round: String(round), unmarkedFinals: String(unmarkedFinals),
        });
        pushToWindow('assistant', response);
        pushMessage('assistant', response);
        // TWO BRANCHES, COMPLETION FIRST. The old wording opened with "Carry on: take the next concrete
        // step now" and mentioned the marker last — and the model obeyed the imperative it was given:
        // finished, told it was mid-work, and offered no legal way to say so, it fabricated a directory
        // scan. Position is load-bearing in a prompt (the middle gets skimmed), so the way OUT goes first.
        pushToWindow('user',
          `Your reply carried no tool call and no $ marker, so the harness cannot tell whether you are done.\n`
          + `IF YOU ARE FINISHED: the FIRST CHARACTER of your reply must be $, then your answer. Nothing else is required — do not `
          + `invent further work to justify another turn.\n`
          + `IF YOU ARE NOT FINISHED: take the next concrete step now, rather than describing it.`);
        continue;
      }
      // A final answer that only says WHAT TO LOOK FOR is not an answer. One nudge, then accepted
      // regardless — an answer that is genuinely uncertain must be able to say so, and a guard that
      // can loop is worse than the behaviour it corrects. See src/deferral.ts.
      if (deferralNudges < 1 && looksLikeDeferral(parsed.text ?? response, touchedAnythingThisTurn())) {
        deferralNudges++;
        recordRaw(round, 'deferral — named what to look for, not what was found', response);
        log('INFO', 'deferral_nudge', { round: String(round) });
        pushToWindow('assistant', response);
        pushMessage('assistant', response);
        pushToWindow('user', DEFERRAL_NUDGE);
        continue;
      }

      // A final answer that REPORTS A CHANGE nobody made. The mirror of the deferral check above and
      // the more dangerous of the two: a deferral is visibly unhelpful, while "Fixed by reordering
      // the operations in Dispose()" reads exactly like a result and is acted on. Unconditional — the
      // QA gate that would otherwise catch this is session-off by default AND declines on "nothing
      // changed this turn", which is the very condition here. See edit-truth.ts.
      if (unwrittenClaimNudges < 1
          && claimsAnEditThatDoesNotExist(parsed.text ?? response, qaChangedFiles().length, toolsRunThisTurn)) {
        unwrittenClaimNudges++;
        recordRaw(round, 'claimed an edit with nothing written', response);
        log('WARN', 'unwritten_claim', { round: String(round), attempts: String(editAttempts().length) });
        addMessage('system', 'reported a change with nothing written — asking it to apply or retract');
        pushToWindow('assistant', response);
        pushMessage('assistant', response);
        pushToWindow('user', getPrompt('unwrittenClaim', { ATTEMPTS: attemptsSummary() }));
        continue;
      }

      const response_ = stripFinalMarker(response);

      // ENTANGLED: a text-only turn is not an ANSWER while the design still has unimplemented types.
      //
      // Measured on the first trial: a 9-type assembly returned 3 types and a to-do list at round 16 of
      // 1000. The model wrote what it would do next, emitted no tool call, and the loop read that as the
      // final answer — "here is my plan" is indistinguishable from "here is my result" to a check that
      // only asks whether a tool was called. This is the behaviour that makes an operator micromanage a
      // multi-file task like a junior, and it is not fixable by asking the model to keep going.
      //
      // A bound design supplies the completion criterion the loop never had: done is not "it stopped
      // talking", it is "every designed type exists". So the adoption gap is fed back and the turn
      // continues. Capped, because a model that cannot make progress must not spin: after
      // MAX_ADOPTION_NUDGES the turn ends honestly with the gap named in the handoff.
      {
        // A GATE STOP OUTRANKS THE COMPLETION CRITERION. The stop told the model to report the gap and
        // wait; nudging it to "take a step now" on the same turn destroys the report — measured, three
        // nudges in a row after one stop and no report ever delivered.
        const gaps = stopAwaitingOperator() ? [] : gateAdoption();
        const done = implementedCount();
        // A file landed since the last nudge, so the loop is advancing rather than spinning: the stall
        // budget is spent only on turns that achieved nothing.
        if (done > lastImplemented) { adoptionNudges = 0; lastImplemented = done; }
        if (gaps.length > 0 && adoptionNudges < MAX_STALLED_NUDGES) {
          adoptionNudges++;
          addMessage('system', `entangled: ${gaps.length} designed type(s) still unimplemented — continuing`);
          log('INFO', 'entangle_adoption_nudge', { remaining: String(gaps.length), nudge: String(adoptionNudges) });
          pushToWindow('assistant', response_);
          pushMessage('assistant', response_);
          // ONE type, with its intent, inline. Listing all of them was measured to be worse than useless:
          // a nine-type task was handed 23 names, most from assemblies it had never been asked to touch,
          // and it responded by trying to switch the gate off. A wall is not a next step.
          pushToWindow('user',
            `NOT DONE. ${gaps.length} designed type(s) do not exist yet. That is the definition of finished `
            + `here — not your own judgement of it. Take exactly one step now, on this:\n\n${nextBrief() ?? ''}`);
          continue;
        }
      }
      recordAnswer(response_);
      transcribeAnswer(response_);
      pushToWindow('assistant', response_);
      pushMessage('assistant', response_);

      // Computed once, before either print path, so the interactive branch below knows WHETHER to
      // defer its immediate print to the Presenter/QA section — same deterministic shape check QA has
      // always used (files changed this turn + the reply reads like a completion report). Each
      // feature's OWN enable check (a session toggle, or a one-shot `/qathis`/`/presentthis` force) is
      // layered independently on top of that shared shape — see qa/index.ts#shouldRunQaThisTurn and
      // presenter/index.ts#shouldRunPresenterThisTurn. Both are called UNCONDITIONALLY (never
      // short-circuited behind `gate.run`) because a one-shot force must be consumed exactly once per
      // turn regardless of whether this particular turn even has the shape to act on — otherwise an
      // unspent force flag would silently fire on a LATER, unrelated turn instead.
      // THE SHAPE CHECK MUST SEE THE SUBSTANTIVE MESSAGE, not whatever the last round happened to
      // emit. In headless, the loop exits on DOUBLE TEXT: round N prints the real completion report,
      // round N+1 repeats or says nothing, and the loop ends there. `response` is then round N+1 —
      // frequently empty — so `qaShouldRun` saw no completion report and declined. Measured: blink
      // logged `run:false, why:"final message is not a completion report", files:2, hasText:false`
      // while the text it had just printed ended with the literal words "Ready for QA". The gate was
      // reading the wrong message, and the fix for the OTHER change-detection bug (files:2, correctly
      // found) had already done its job — this was a second, independent reason QA never ran.
      const finalText = parsed.text?.trim() ? parsed.text : (lastPrintedText || response);
      const gate = qaShouldRun(finalText);
      const qaWantsToRun = shouldRunQaThisTurn();
      const presenterWantsToRun = shouldRunPresenterThisTurn();
      const doQa = gate.run && qaWantsToRun;
      const doPresenter = gate.run && presenterWantsToRun && !HEADLESS;

      if (HEADLESS) {
        // CTA gate — if there's a deliverable the model hasn't produced, don't exit
        if (ctaTarget && !ctaDelivered && round < maxRounds - 2) {
          pushToWindow('user', getPrompt('ctaReminder', { TARGET: ctaTarget }));
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
      } else if (!(doQa || doPresenter)) {
        // Ordinary turn — neither feature is enabled/forced for it — print immediately, as always.
        if (parsed.text) addMessage('assistant', parsed.text);
      }
      // else (interactive AND at least one of Presenter/QA will run this turn): the print is DEFERRED
      // to the section below — whichever of the two runs decides the primary visible text, not the
      // raw model output.

      setAgentStatus('');
      triggerSync();

      // ── Presenter pass, then the QA gate ──────────────────────────────
      // Presenter runs FIRST, on the same deterministic condition QA uses (files changed + reply reads
      // like a completion report): one quick LLM call decides whether this reply IS the thing the user
      // must read literally (a warning/rejection/error/question — never rewritten) or reports on
      // completed work, in which case Presenter builds a short, consistent answer (what was asked, one
      // line of what this satisfies, a bulleted file-changed list) and QA reviews THAT text instead of
      // the raw reply — a denser, more complete "what changed" statement is strictly better evidence
      // for the reviewer to check claims against. Interactive-only: headless output stays exactly as it
      // was (scripts/`ayin watch` parse that output; a TUI-shaped feature — status chip, cursive aside —
      // has no headless equivalent to be worth the behavior change there).
      let textForQa = response;
      if (!interrupted) {
        log('INFO', 'qa_gate_condition', { run: String(gate.run), why: gate.why, files: String(gate.files.length), qa: String(doQa), presenter: String(doPresenter) });
        if (doQa || doPresenter) {
          if (doPresenter) {
            // Presenter's project-type executor regenerates artifacts too, so it is handed whatever
            // the QA executor's `prepare()` already covered in an earlier pass of this same turn —
            // one grounding call per unit per turn, never two, whichever gate ran first.
            const presenterOutcome = await presenterPass(getGoal() || currentGoal, response, gate.files, qaPreparedUnits());
            if (presenterOutcome.presented && presenterOutcome.text) {
              addMessage('assistant', presenterOutcome.text);
              // TESTING-ERA ONLY, per the operator: still show the raw reply too, de-emphasized in
              // (fake, Unicode-math-italic — blessed has no real italic attribute) cursive BELOW the
              // presentation, so the two can be compared while Presenter is new. Once trusted, this
              // block goes away and the presentation stands alone — that's the only change needed here.
              if (parsed.text) {
                const preview = parsed.text.length > 2000 ? `${parsed.text.slice(0, 2000)}\n… (truncated, ${parsed.text.length} chars total)` : parsed.text;
                addMessage('system', [
                  `{${theme.faint}-fg}${escapeBlessedTags(toItalic('(original reply, shown for testing while Presenter is new)'))}{/}`,
                  `{${theme.muted}-fg}${escapeBlessedTags(toItalic(preview))}{/}`,
                ].join('\n'));
              }
              textForQa = presenterOutcome.text;
            } else if (parsed.text) {
              // Presenter declined (literal/warning/error/question/not-a-presentation, or disabled) —
              // show the raw reply exactly as interactive mode always has.
              addMessage('assistant', parsed.text);
            }
          } else if (parsed.text) {
            // Presenter not running this turn (toggle off, no `/presentthis`, or headless) — QA alone
            // is running, so the raw reply still needs to be shown; QA never replaces the visible text.
            addMessage('assistant', parsed.text);
          }

          if (doQa) {
            const outcome = await qaGate(getGoal() || currentGoal, textForQa, gate.files, () => interrupted);
            qaShowCard(outcome.card);
            if (outcome.action === 'fix' && outcome.feedback && !interrupted) {
              pushToWindow('user', outcome.feedback);
              // Give the repair a real runway: without this a gate that fires on the last round has
              // no rounds left to fix anything. Bounded by qaMaxPasses, not by rounds.
              round = Math.min(round, Math.max(0, maxRounds - 5));
              log('INFO', 'qa_fix_pass', { pass: String(outcome.pass), issues: String(outcome.verdict?.issues.length ?? 0), roundReset: String(round) });
              continue;
            }

            // The wiring diagram used to be regenerated HERE, after a passing verdict. That ordering
            // was the bug: the `arduino-wiring-diagram` criterion asks whether a rendered `.wiring.puml`
            // exists, so on pass 1 the judge was shown a project whose diagram had not been written
            // yet, failed it, and spent an entire fix pass — two LLM calls plus another agent round —
            // producing what this line was about to produce anyway. Artifact generation now happens in
            // the QA executor's `prepare()`, BEFORE the judge reads anything (see
            // executors/qa/arduino/index.ts), so the criterion is answerable on the first pass and the
            // common case costs one pass instead of two.
          }
        }
      }

      // ── required project-type artifacts, UNCONDITIONALLY ──────────────
      // A REQUIRED DELIVERABLE MUST NOT DEPEND ON A CONDITIONAL GATE. The Arduino wiring diagram was
      // produced in two places, both optional: the agent calling `arduino_diagram` itself, and the QA
      // executor's `prepare()`. Measured on the benchmark: blink scored 13/13 in one run and 10/13 in
      // the next with no diagram at all, because the first run's PLAN listed "run arduino_diagram" as a
      // step and the second run had no plan, while QA — the backstop — declined for an unrelated
      // reason. Two conditional producers, both off, and a required file simply absent.
      //
      // Cheap and idempotent: `regenerateTouchedDiagrams` returns null unless a sketch is among this
      // turn's changed files, and `isDiagramCurrent` skips any sketch whose diagram is already newer
      // AND carries the tool's provenance stamp. So a question-answering turn costs nothing, a second
      // pass over unchanged code costs nothing, and the one case that does spend a grounding call is
      // the case where the deliverable is genuinely stale.
      if (!interrupted && gate.files.length > 0) {
        try {
          const regen = await regenerateTouchedDiagrams(process.cwd(), gate.files, qaPreparedUnits());
          if (regen && regen.results.length > 0) {
            addMessage('system', `Wiring diagram: ${regen.results.map((r) => r.svgPath ?? r.pumlPath).join(', ')}`);
          }
        } catch (err) {
          log('WARN', 'arduino_diagram_deliverable_failed', { error: err instanceof Error ? err.message : String(err) });
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
      // A slash-only tool EXISTS but is not the agent's to call. Saying "unknown tool" would be a lie
      // the model would then try to route around; saying who can run it is actionable.
      if (tool?.slashOnly) {
        setAgentStatus('');
        const msg = `${name} is not available to you — it is an operator command (/${tool.slash?.command ?? name}). `
          + 'Ask for its output in the reply, or work from what is already in the conversation.';
        addMessage('system', `${name}: operator-only, not called`);
        log('INFO', 'slash_only_tool_refused', { tool: name });
        pushToWindow('assistant', textPrefix ? `${textPrefix}\n[Called ${name}]` : `[Called ${name}]`);
        noteRanCall(name, JSON.stringify(params).slice(0, 80), false, msg);
        pushToWindow('user', renderToolResult(`Error: ${msg}`));
        continue;
      }
      if (!tool) {
        setAgentStatus('');
        const shellLike = /^(git|npm|node|python|bash|sh|curl|grep|find|ls|cat|cd|mv|cp|rm|mkdir|echo|sed|awk|jq)$/.test(name);
        const availableNames = modelTools().map(t => t.name).join(', ');
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
        noteRanCall(name, `missing ${missingNames}`, false, 'required parameter(s) not supplied');
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
        noteRanCall(name, JSON.stringify(params).slice(0, 80), false, guard.label ?? 'blocked');
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
          noteRanCall(name, JSON.stringify(params).slice(0, 80), false, 'denied: read-only session');
          pushToWindow('user', renderToolResult(getPrompt('readonlyDenied', { TOOL: name })));
          continue roundLoop;
        }
        addMessage('system', `Denied: ${name}(${paramPreview})`);
        log('INFO', 'tool_denied', { tool: name });

        interrupted = false;
        setAgentStatus('Explaining...');
        try {
          const explanation = await llmChat([{
            role: 'user',
            content: getPrompt('permissionDeniedExplain', { TOOL: name, PARAMS: paramPreview }),
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
      if (name === 'write_file' && !isUnchained() && gatheredFacts.length + evidenceFacts.length >= 2) {
        const content = params.content || '';
        if (content.length > 200 && directions.length < MAX_DIRECTIONS) {
          const criticResult = await runCritic(content, [...gatheredFacts, ...evidenceFacts]);
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
                pushToWindow('user', renderToolResult(getPrompt('criticRejectionHeadless', {
                  CRITIQUE: criticResult,
                  PREVIOUS_DIRECTIONS: directions.map((d, i) => `${i + 1}. ${d.substring(0, 100)}`).join('\n'),
                })));
                continue roundLoop;
              } else {
                // Interactive: report to user
                addMessage('system', `[critic found issues — reporting to user]`);
                pushToWindow('assistant', `[write_file reviewed — issues found]`);
                pushToWindow('user', renderToolResult(getPrompt('criticRejectionInteractive', { CRITIQUE: criticResult })));
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
      // Tools are timed too: a ten-minute turn is as often one shell command that never returned as
      // it is a slow model, and the status line cannot tell them apart.
      // Named in the live mirror for the whole run: a connector waiting on an external API is
      // indistinguishable, from outside, from a model that will not answer — and both look like a
      // spinner. `tool` with an old timestamp says which it is without asking anyone to type anything.
      liveTool(name);
      // A tool that could have changed the tree invalidates the explore cache — the list is inverted
      // in cache.ts, so anything not known to be read-only clears it. A stale hit would send the agent
      // to line numbers that no longer exist, which is worse than the seconds it saves.
      exploreCacheNoteTool(name);

      // A TOOL THAT HAS NOT WORKED THIRTEEN TIMES WILL NOT WORK ON THE FOURTEENTH.
      //
      // Measured on one real session: 30 `find_files` calls across 26 rounds, each with a slightly
      // different glob, ending with no answer at all. Nothing was repeated exactly, so no cache could
      // catch it — the model was not stuck on one query, it was stuck on one STRATEGY. Left alone it
      // spends the whole turn there, and the operator watches a spinner for two and a half minutes.
      //
      // The nudge is deterministic and it names the alternatives, because "try something else" is
      // advice a model cannot act on. Fired on a schedule rather than once: a loop that survives the
      // first nudge is exactly the one that needs the second.
      const used = (toolUseCounts.get(name) ?? 0) + 1;
      toolUseCounts.set(name, used);
      if (used % LOOP_NUDGE_EVERY === 0) {
        const alt = name === 'find_files' || name === 'grep'
          ? 'explore (it derives identifiers and searches for you), or read a directory listing to see what is actually there'
          : 'a different tool, or state what you have and what is missing';
        addMessage('system', `[${name} used ${used}× this turn — changing approach]`);
        pushToWindow('user', renderToolResult(
          `You have called ${name} ${used} times in this turn and it has not answered the question. `
          + `It will not answer on the next call either. Change approach: try ${alt}. `
          + `If the thing you are looking for may not exist under that name, say so and work from what you have.`));
        log('INFO', 'tool_loop_nudge', { tool: name, uses: String(used) });
      }
      const toolPromise = timed('tool', name, () => tool.execute(params),
        (line) => { addMessage('system', line); }).catch(
        (err: unknown) => `Error: ${err instanceof Error ? err.message : String(err)}`,
      ).finally(() => liveTool(null));

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

      /**
       * IN NATIVE MODE THE ASSISTANT TURN CARRIES NOTHING TO COPY.
       *
       * A model imitates its own previous turns — that is the whole mechanism behind this bug, and it
       * does not care what the text is. Rendering the call back as ayin XML taught glm-4.7-flash to
       * write `<function>bash>` (session bdf1463c, round 12). Replacing that with a neutral
       * `[called read_file(path=…)]` taught it to write THAT instead — verbatim, truncation and all,
       * as its round-2 reply (session 60316a08). Two shapes, same lesson: any description of a call,
       * sitting in an assistant turn, is a worked example the model will follow.
       *
       * So in native mode the assistant turn holds only what the model actually SAID in prose, and the
       * call is identified on the RESULT instead — a user-role message, which is not the model's own
       * voice and is not imitated as output. In prompt mode the XML stays: the model really did write
       * it, and its transcript must be its own.
       */
      const nativeMode = toolMode() === 'native';
      if (nativeMode) {
        if (textPrefix) pushToWindow('assistant', textPrefix);
      } else {
        const callXml = renderToolCall({ name, params });
        pushToWindow('assistant', textPrefix ? `${textPrefix}\n\n${callXml}` : callXml);
      }

      if (timeoutResult === 'timeout') {
        const taskId = registerTask(name, paramPreview);
        addMessage('system', `${name} still running (>${BACKGROUND_TIMEOUT / 1000}s), continuing... [task ${taskId}]`);
        log('INFO', 'tool_backgrounded', { tool: name, taskId });

        pushToWindow('user', renderToolResult(`${name} is still running in the background (task ${taskId}). It started ${BACKGROUND_TIMEOUT / 1000}s ago. You can call the \`status\` tool to check progress, or continue with other work — the result will also arrive automatically.`));
        noteRanCall(name, paramPreview, true, `still running in the background as task ${taskId}`);
        pushMessage('assistant', `[tool: ${name}(${paramPreview}) → backgrounded, task ${taskId}]`);

        toolPromise.then(r => {
          completeTask(taskId, r);
          saveArtifact(name, paramPreview, r);
          recordTool(name, paramPreview, r, true);
          transcribeTool({ round, tool: name, params, result: r, ms: Date.now() - toolStarted, backgrounded: true });
          addMessage('tool', `${formatToolCallForChat(name, `task ${taskId} completed`)}\n${formatToolResultForChat(name, r, Date.now() - toolStarted)}`);
          pushToWindow('user', renderToolResult(`Background ${name} (task ${taskId}) completed:\n${clipForWindow(r)}`));
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
      // FULL params (not the 60-char-per-value preview) and the FULL result — the operating record
      // clips both at 4000 chars, which is exactly the part that explains the next model turn.
      transcribeTool({ round, tool: name, params, result, ms: Date.now() - toolStarted });

      let ctaJustDelivered = false;
      // One formatter for every tool: write_file gets the diff card, the rest a tag-escaped
      // gutter-block preview (raw braces in bash/grep output used to break blessed markup),
      // both closed by a ✓/✗ + duration footer.
      addMessage('tool', formatToolResultForChat(name, result, Date.now() - toolStarted));
      // Artifact tracking for the QA gate. `bash`-driven changes are caught separately by the
      // gate's git snapshot — this covers the tools whose target is known from the call itself.
      toolsRunThisTurn++;
      // ONLY ON SUCCESS. A failed `str_replace` used to be recorded as a file this turn changed, so a
      // turn whose every edit bounced still reported one changed file — which is both a lie to the QA
      // gate and the exact signal the fabrication guard reads. The ledger keeps the failures instead,
      // where they are evidence rather than a phantom write. See edit-truth.ts.
      let editMissNote = '';
      if ((name === 'write_file' || name === 'str_replace') && params.path) {
        if (noteEditAttempt(name, params.path, result)) qaNoteTouched(params.path);
        else if (consecutiveMissesOn(params.path) >= 2) {
          // Two misses on ONE file means the model is editing text it has not read, and a third guess
          // costs another round to learn the same thing. Said at the tool result, where it can still
          // act on it — by the final answer it has nothing left to fix.
          editMissNote = `\n\n${consecutiveMissesOn(params.path)} edits in a row have missed in this file. `
            + `Stop guessing old_str: read the exact lines first (read_file ${params.path} with offset), `
            + `copy old_str from what comes back, then edit.`;
          log('WARN', 'edit_repeated_miss', { tool: name, path: params.path, misses: String(consecutiveMissesOn(params.path)) });
        }
      }
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
      /**
       * The result SAYS WHICH CALL IT ANSWERS, because in native mode the assistant turn no longer does
       * (see above). This is a user-role message: the model reads it as input, not as an example of its
       * own output, so naming the call here does not teach a shape to copy.
       */
      const resultHead = nativeMode ? `${name}(${paramPreview}) →\n` : '';
      noteRanCall(name, paramPreview, true, result);
      pushToWindow('user', renderToolResult(resultHead + clipForWindow(result) + (guard.note ?? '') + editMissNote));
      pushMessage('assistant', `[tool: ${name}(${paramPreview})]`);

      // CTA just delivered — tell the model it's done. This prevents the
      // "write then re-write to confirm" loop Gemma4 falls into.
      if (ctaJustDelivered) {
        pushToWindow('user', getPrompt('ctaDeliveredStop', { TARGET: ctaTarget }));
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
      } else if (
        EVIDENCE_TOOLS.has(name) &&
        result.length > 20 &&
        !/^(0 matches|0 files match|Error:|Command exited)/.test(result)
      ) {
        // A miss is not evidence: "0 matches" must not count as progress, or the judge is lied to in
        // the other direction.
        evidenceFacts.push(`[${name} ${paramPreview}] ${result.slice(0, EVIDENCE_CHARS).replace(/\s+/g, ' ').trim()}`);
        if (evidenceFacts.length > EVIDENCE_MAX) evidenceFacts.shift();
      }

      // Judge gate — every JUDGE_INTERVAL tool calls, evaluate progress
      totalToolCalls++;
      const shouldJudge = !isUnchained() && totalToolCalls > 0 &&
        totalToolCalls % JUDGE_INTERVAL === 0 &&
        judgeVerdict?.confidence !== 'high';

      if (shouldJudge) {
        addMessage('system', '[evaluating progress...]');
        judgeVerdict = await callJudge(currentGoal, [...gatheredFacts, ...evidenceFacts]);
        log('INFO', 'judge_routed', { confidence: judgeVerdict?.confidence || 'unknown', totalTools: String(totalToolCalls) });

        const wantsMore = judgeVerdict?.confidence === 'mid' || judgeVerdict?.confidence === 'low';
        if (wantsMore && judgeExtensions < MAX_JUDGE_EXTENSIONS) {
          judgeExtensions++;
          judgeRoundsGranted = 5;
          const label = judgeVerdict?.confidence === 'mid' ? 'on track' : 'not there yet';
          addMessage('system', `[progress: ${label} (${judgeExtensions}/${MAX_JUDGE_EXTENSIONS}) — ${judgeVerdict?.reasoning}]`);
        } else if (wantsMore) {
          addMessage('system', `[progress: out of extensions — wrapping up. ${judgeVerdict?.reasoning}]`);
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
    pushToWindow('user', getPrompt('ctaForceWrite', { TARGET: ctaTarget }));
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

  // The handoff is what a human or the NEXT agent reads to learn what this run established. It used to
  // count `gatheredFacts` alone — explore results — and so printed "No facts gathered." after a run
  // that had made 19 successful searches and reads and written a correct diagnosis. A self-audit that
  // understates the work is the same defect as a tool that understates its output.
  const evidence = [...gatheredFacts, ...evidenceFacts];
  const factsPreview = evidence.length > 0
    ? `\nEvidence gathered (${evidence.length}: ${gatheredFacts.length} explore, ${evidenceFacts.length} direct read/search):\n` +
      evidence.map((f, i) => `  ${i + 1}. ${f.substring(0, 100)}`).join('\n')
    : '\nNo evidence gathered — nothing was read or searched.';

  const directionsPreview = directions.length > 0
    ? `\nDirections tried: ${directions.map(d => d.substring(0, 80)).join('; ')}`
    : '';

  // `round 3/Infinity` is what an uncapped budget prints if the denominator is not guarded.
  const budget = Number.isFinite(maxRounds) ? `round ${round}/${maxRounds}` : `round ${round}`;
  process.stdout.write(`\n--- HANDOFF (${reason}, ${budget}) ---\n`);
  process.stdout.write(`Original prompt: ${userInput.substring(0, 200)}\n`);
  process.stdout.write(`CTA: ${ctaTarget || '(none detected)'} — ${ctaDelivered ? 'DELIVERED' : 'NOT DELIVERED'}\n`);
  process.stdout.write(`Tool calls: ${totalToolCalls} (explore: ${exploreCallCount})\n`);
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
        content: getPrompt('selfAudit', {
          TASK: userInput,
          MAX_ROUNDS: String(maxRounds),
          RECENT_WORK: recentWork,
        }),
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
      content: getPrompt('interruptReport', {
        TASK: userInput,
        ROUNDS: String(roundsSoFar),
        RECENT_WORK: recentWork,
      }),
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
