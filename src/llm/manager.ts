/**
 * Ayin LLM manager — the single seam between ayin's model-AGNOSTIC agent loop
 * and the model-FAMILY-specific surface (tool-call format, parsing, result
 * framing). Every LLM call ayin makes goes through here:
 *
 *     ayin tool / agent loop
 *          │  llmChat / llmCall            (messages → text)
 *          ▼
 *     manager ── resolves the ACTIVE model the provider reports (status() →
 *          │      {model}) → picks the matching dialect
 *          ▼
 *     dialect ── toolCallInstructions (→ system prompt) · parse(raw)
 *                · renderToolCall · renderToolResult
 *
 * ayin neither chooses nor knows WHY the served model changes — a backend is free
 * to swap it at runtime (e.g. loading a coder model for a coding task); ayin simply
 * observes status() and re-resolves the dialect.
 *
 * WHERE THE CALL ACTUALLY GOES is the provider's business (provider.ts + select.ts):
 * `generate` is one of its two REQUIRED methods, so this file works the same whether
 * the endpoint is a plain adapter or an arbitrated resource layer. The transport
 * underneath (retries, image attach, OpenAI fallback) still lives in connection.ts.
 * Add a model family by implementing ModelDialect (see types.ts) and registering it
 * in DIALECTS below. See docs/ARCHITECTURE.md "LLM manager & dialects".
 */

import { log } from '../log.js';
import { getPrompt } from '../prompts.js';
import { timed, takeLlmPurpose } from '../timing.js';
import type { LlmMessage, ModelDialect, ParseAllResult, ParsedToolCall } from './types.js';
import { GemmaDialect } from './dialects/gemma.js';
import { GlmDialect } from './dialects/glm.js';
import { GlimmerDialect } from './dialects/glimmer.js';
import { NativeToolDialect } from './dialects/native.js';
import { QwenDialect } from './dialects/qwen.js';
import { narrateWait } from '../wait-narrator.js';
import { llmProvider } from './select.js';

// Registered dialects, in match-priority order. The first whose matches() returns
// true for the active model wins; DEFAULT is used until the model id is known.
// FIRST, because it is the most specific match and the only one whose absence was a bug: without it
// an OpenAI model fell through to the gemma fallback and was told, in prose, to emit XML tool calls
// that its API was already carrying natively.
const DIALECTS: ModelDialect[] = [new NativeToolDialect(), new QwenDialect(), new GlimmerDialect(), new GlmDialect(), new GemmaDialect()];
const DEFAULT: ModelDialect = DIALECTS[DIALECTS.length - 1]; // gemma — used until the model id is known

let cachedModelId = '';
let cachedDialect: ModelDialect = DEFAULT;

/**
 * RESOLUTION IS RETRIED UNTIL IT LANDS. It used to be attempted exactly once per process, and the
 * latch was set BEFORE the attempt — so a single missed `/api/status` (a backend still booting, an
 * authority not yet held, a provider still provisional) pinned `cachedModelId` to `''` and the dialect
 * to the gemma DEFAULT for the whole session, silently.
 *
 * That is not a cosmetic default. The dialect is HOW TOOL CALLS ARE FORMATTED, so an unresolved model
 * id means a qwen model being taught gemma's convention on every round — measured in a real bundle as
 * `"model": "unknown", "dialect": "gemma"` against a qwen3-coder endpoint, and the operator's evidence
 * for it was a model that "emits `<function=`", which reads as a model quirk and is not one.
 *
 * Bounded, and it SAYS SO when it gives up: an endpoint that genuinely never reports a model is a real
 * configuration, and guessing at it forever is its own bug. Roughly a minute of a booting backend.
 */
const MODEL_RETRY_MS = 5_000;
const MODEL_MAX_ATTEMPTS = 12;
let modelAttempts = 0;
let modelLastAttemptAt = 0;
let modelRefreshInFlight = false;
let modelGiveUpWarned = false;

/**
 * The window the served model will actually be given, in tokens — 0 until a provider reports one.
 *
 * ZERO MEANS UNKNOWN, and every consumer must treat it that way rather than substituting a number of
 * its own. `tokens.ts` used to fall back to a flat 65536, so an operator on a 16k preset read a meter
 * claiming four times the room they had while the runtime truncated the prompt in silence. The
 * resource layer had been reporting the true `ctxSize` the whole time; nothing asked it.
 */
let cachedContextTokens = 0;

/** The served model's context window in tokens, or 0 when no provider has reported one. */
export function activeContextTokens(): number { return cachedContextTokens; }

/**
 * An adapter chosen by the OPERATOR, overriding what the model id suggests.
 *
 * ayin does not own the model on a shared host — another process may be serving whatever it likes, and
 * ayin must not force a swap to suit itself. What it CAN choose is how to speak to what is there. So the
 * adapter is selectable: point ayin at the gemma adapter and it talks gemma, whatever the endpoint calls
 * the model. Empty means "match on the served model id", which is right almost always.
 */
let adapterOverride = '';

export function adapterNames(): string[] {
  return DIALECTS.map((d) => d.id);
}

/** '' clears the override and returns to matching on the model id. Unknown name → false, nothing changes. */
export function setAdapter(name: string): boolean {
  const want = name.trim().toLowerCase();
  if (!want || want === 'auto') {
    adapterOverride = '';
    cachedDialect = pickDialect(cachedModelId);
    log('INFO', 'adapter_override_cleared', { resolved: cachedDialect.id });
    return true;
  }
  const found = DIALECTS.find((d) => d.id.toLowerCase() === want);
  if (!found) return false;
  adapterOverride = found.id;
  cachedDialect = found;
  // Not an error — blindfolding ayin deliberately is the operator's to do. But an accident looks
  // identical to an intention, so the disagreement is stated once, here, rather than discovered later
  // as a model that stopped calling tools.
  const natural = DIALECTS.find((d) => d.matches(cachedModelId));
  const disagrees = cachedModelId !== '' && natural !== undefined && natural.id !== found.id;
  log(disagrees ? 'WARN' : 'INFO', 'adapter_override', {
    adapter: found.id,
    model: cachedModelId || '(unknown)',
    ...(disagrees ? { wouldHaveMatched: natural.id } : {}),
  });
  mismatchWarned.clear();
  return true;
}

export function activeAdapter(): { id: string; forced: boolean } {
  return { id: cachedDialect.id, forced: adapterOverride !== '' };
}

function pickDialect(modelId: string): ModelDialect {
  if (adapterOverride) return DIALECTS.find((d) => d.id === adapterOverride) ?? DEFAULT;
  return DIALECTS.find(d => d.matches(modelId)) ?? DEFAULT;
}

/**
 * Keep trying to learn the served model, in the background, until we know it.
 *
 * Called from `activeDialect()` — i.e. on the path of every LLM call — so the retry rides on work that
 * was happening anyway and costs nothing on a session that resolved at boot. Never awaited: a status
 * probe must not put latency in front of a generation.
 */
function ensureRefreshed(): void {
  if (cachedModelId) return;                                   // resolved — nothing to chase
  if (adapterOverride) return;                                 // the operator chose; the id is moot
  if (modelRefreshInFlight) return;
  if (Date.now() - modelLastAttemptAt < MODEL_RETRY_MS) return;
  if (modelAttempts >= MODEL_MAX_ATTEMPTS) {
    if (!modelGiveUpWarned) {
      modelGiveUpWarned = true;
      // The one thing that must not stay quiet. Driving the wrong dialect looks, from the outside,
      // exactly like a model that is bad at tool calls.
      log('WARN', 'llm_model_unresolved', {
        attempts: String(modelAttempts),
        dialect: cachedDialect.id,
        hint: `the endpoint never reported a model id, so tool calls are being formatted for `
          + `${cachedDialect.id} by fallback — set it explicitly with /model <adapter> if that is wrong`,
      });
    }
    return;
  }
  void refreshActiveModel();
}

/**
 * Forget which model is served, so the next call re-learns it. Call whenever the PROVIDER changes.
 *
 * Without this, switching provider keeps the previous provider's model id — and therefore its dialect
 * — whenever the new one does not report a model on the first ask. That is the same silent-wrong-
 * dialect failure as the one-shot latch above, arriving through the switch instead of through boot.
 */
export function resetModelResolution(): void {
  cachedModelId = '';
  cachedContextTokens = 0; // a different provider grants a different window; never carry the old one
  resetTokenRatio();        // and a different tokenizer packs a different number of chars per token
  cachedDialect = adapterOverride ? cachedDialect : DEFAULT;
  modelAttempts = 0;
  modelLastAttemptAt = 0;
  modelGiveUpWarned = false;
}

/** Whether the served model is still unknown, and how hard we have tried. For the status line, the
 *  debug manifest, and anything else that would otherwise report a fallback as a fact. */
export function modelResolution(): { resolved: boolean; attempts: number; gaveUp: boolean } {
  return {
    resolved: cachedModelId !== '',
    attempts: modelAttempts,
    gaveUp: modelAttempts >= MODEL_MAX_ATTEMPTS && cachedModelId === '',
  };
}

/**
 * Refresh the active model id from the backend (GET /api/status → {model}) and
 * re-resolve the dialect. Non-fatal: on any failure the current dialect is kept
 * (gemma by default). Call on connect, and whenever the backend may have swapped
 * the served model.
 */
export async function refreshActiveModel(): Promise<void> {
  // Counted and stamped HERE, around the actual attempt — the old code latched on entry, which is
  // what turned one unlucky probe into a session-long wrong dialect.
  modelRefreshInFlight = true;
  modelAttempts++;
  modelLastAttemptAt = Date.now();
  try {
    const provider = await llmProvider();
    const mode = provider.tools ?? 'prompt';
    if (mode !== cachedToolMode) {
      cachedToolMode = mode;
      log('INFO', 'tool_declaration_mode', { provider: provider.name, mode });
    }
    // RECONCILE HERE TOO, NOT ONLY AFTER THE DIALECT IS PICKED.
    //
    // The provider re-asserts `native` on every refresh, but the model-id guard below returns early
    // when the model has not changed — so a degrade that lives only after that guard is undone by the
    // next refresh and never reapplied. `ayin -p` refreshes twice (an un-awaited probe on the dialect
    // path, then an awaited one before the first round), which is exactly that shape: the second call
    // restored `native`, the prompt then omitted the catalogue, and the provider's rendered
    // `<function=…>` XML went to a model that speaks ATEM.
    reconcileToolMode();
    const s = await provider.status();
    // Learned from the SAME call that learns the model, because it changes with it: a preset swap
    // changes the model and the window together, and reading them from two places is how they drift.
    // Recorded even when the model id is unchanged — the operator can raise the window without
    // touching the model, and the meter must follow.
    if (typeof s.contextTokens === 'number' && s.contextTokens > 0 && s.contextTokens !== cachedContextTokens) {
      log('INFO', 'llm_context_window', { tokens: String(s.contextTokens), was: String(cachedContextTokens || 0) });
      cachedContextTokens = s.contextTokens;
    }
    const modelId = s.ok ? String(s.model ?? '') : '';
    if (!modelId || modelId === cachedModelId) return;
    cachedModelId = modelId;
    // A preset swap mid-session changes the tokenizer under a running agent. The ratio measured from
    // the old model describes nothing about the new one.
    resetTokenRatio();
    const next = pickDialect(modelId);
    if (next.id !== cachedDialect.id) {
      log('INFO', 'llm_dialect_switch', { model: modelId, dialect: next.id });
    }
    cachedDialect = next;
    // The dialect just settled — re-apply, since the mode reconciled above was judged against the
    // PREVIOUS dialect (on a cold session, the gemma default).
    reconcileToolMode();
    // Worth a line even when the dialect did not change: "resolved to gemma because the model IS
    // gemma" and "still gemma because nothing answered" are the two states this whole retry exists to
    // tell apart, and only one of them is fine.
    log('INFO', 'llm_model_resolved', { model: modelId, dialect: next.id, attempts: String(modelAttempts) });
  } catch { /* unreachable backend — keep current dialect, and ensureRefreshed will try again */ }
  finally { modelRefreshInFlight = false; }
}

/**
 * The dialect for the currently-active backend model (sync; uses the last refresh).
 *
 * IN NATIVE MODE THE MODEL'S OWN SYNTAX IS NOT WHAT AYIN READS. The runtime parses the tool calls and
 * the provider renders them BACK into the canonical `<function=…>` text (see `providers/openai.ts`
 * and the resource provider's `renderNativeCalls`), so the text arriving here is the provider's, not
 * the model's. Matching on the model id then picks a dialect for a syntax nobody emitted.
 *
 * Measured: with native tools on, muse-glimmer's calls were parsed by Ollama, re-rendered as
 * `<function=bash>…`, and handed to the GLIMMER dialect — which only reads ATEM. Zero tool calls, 35
 * rounds of a model correctly emitting calls that ayin threw away. `qwen` and `gemma` hid the bug
 * because their dialects read that same XML form by coincidence.
 *
 * An explicit operator adapter still wins: blindfolding ayin deliberately remains the operator's to do.
 */
export function activeDialect(): ModelDialect {
  ensureRefreshed();
  if (!adapterOverride && cachedToolMode === 'native') {
    return DIALECTS.find((d) => d.id === 'native') ?? cachedDialect;
  }
  return cachedDialect;
}

/** The active backend model id, or '' before the first successful refresh. */
export function activeModelId(): string { return cachedModelId; }

// ── Dialect-delegating surface (everything model-specific) ───────────
/**
 * Empty when the provider declares tools to the runtime: the format is the runtime's business then, and
 * a second instruction would contradict it.
 */
export function toolCallInstructions(): string {
  return toolMode() === 'native' ? '' : activeDialect().toolCallInstructions();
}

/** Who declares tools right now. Sync, because the system prompt is assembled synchronously. */
/**
 * Drop to prompt-declared tools when the resident model's own dialect cannot carry native ones.
 *
 * Native declaration round-trips a turn twice: the server parses the model's output into structured
 * calls, the provider renders them back to canonical `<function=…>` XML, and that text returns as an
 * assistant message in the NEXT request — where the server re-renders history in the model's own
 * format. A model whose format is ATEM cannot parse that XML, and answers
 * `500 parse Glimmer call to <tool>: malformed ATEM parameter`.
 *
 * Idempotent and cheap, so it is safe to call on every refresh — which is required, because the
 * provider re-asserts its own mode each time.
 */
function reconcileToolMode(): void {
  // UPGRADE, when prompt mode cannot work at all. A dialect owns only half the contract: the server
  // runs its own parser regardless, and when that parser eats the syntax ayin asked for, there is
  // nothing left to parse. Leaving such a model in prompt mode makes it emit tool calls into a void
  // and look like it ignores instructions — which is how a mis-driven model gets called stupid.
  if (cachedToolMode !== 'native' && cachedDialect.requiresNativeTools) {
    cachedToolMode = 'native';
    log('INFO', 'tool_declaration_mode', {
      provider: 'resource', mode: 'native', reason: `${cachedDialect.id} requires native tools`,
    });
    return;
  }
  if (cachedToolMode !== 'native' || !cachedDialect.rejectsNativeTools) return;
  cachedToolMode = 'prompt';
  log('INFO', 'tool_declaration_mode', {
    provider: 'resource', mode: 'prompt', reason: `${cachedDialect.id} rejects native tools`,
  });
}

let cachedToolMode: 'native' | 'prompt' = 'prompt';
export function toolMode(): 'native' | 'prompt' { return cachedToolMode; }
/** Adapter pairs already reported this session, so a mismatch is named once and not on every round. */
const mismatchWarned = new Set<string>();

/**
 * Parse, and SAY SO when the reply is in another adapter's format.
 *
 * The failure this catches is silent by construction: an adapter that cannot parse a reply finds zero
 * tool calls, and zero tool calls is indistinguishable from a model that chose to answer in prose. The
 * loop then treats a tool-calling turn as a final answer, and the operator sees a model that "ignored its
 * tools" — the diagnosis costs an hour and the cause is one setting.
 *
 * So when the active adapter finds nothing, every OTHER adapter is offered the same text. If one of them
 * would have parsed it, that is not a model problem and it is not ambiguous: it is named, with the fix.
 * Only runs on the failure path, so a working session pays nothing.
 */
/** Did the active dialect see a tool call the model never finished writing? */
export function replyTruncated(raw: string): boolean {
  const d = activeDialect();
  try { return d.truncated?.(raw) === true; } catch { return false; }
}

/**
 * Did the model WRITE a tool call that no dialect could parse, and then stop?
 *
 * The sibling of `replyTruncated`, and the same silent failure from the other direction. There the call
 * was cut off; here it arrived complete in a shape ayin does not speak — observed live as
 * `[str_replace(path=…, old_str=…, new_str=…)]`, which every dialect parses to zero calls. Zero calls is
 * indistinguishable from a finished answer, so the loop printed the call at the operator as prose, said
 * "Done.", and changed nothing. The file was reported edited and was not.
 *
 * `parseToolCalls` already offers the text to every other dialect, so by the time this runs the shape is
 * one NO dialect accepts — the model invented it. The only move left is to say so and ask again.
 *
 * DELIBERATELY NARROW, because a false positive turns a correct answer into a wasted round: the match
 * must be a known tool name at the start of a line, opening a paren, with a `name=` argument — the shape
 * of an invocation, not of prose that mentions a tool. Fenced code blocks are stripped first, so an
 * answer that legitimately SHOWS a call while explaining one is not mistaken for making it.
 */
export function unexecutedCallText(raw: string, toolNames: readonly string[]): string | null {
  if (!raw) return null;
  const prose = raw.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const name of toolNames) {
    const re = new RegExp(`(^|\\n)\\s*\\[?\\s*${name}\\s*\\(\\s*\\w+\\s*=`);
    if (re.test(prose)) return name;
  }
  return null;
}

export function parseToolCalls(raw: string): ParseAllResult {
  const active = activeDialect();
  const result = active.parse(raw);
  if (result.toolCalls.length > 0 || raw.trim().length < 20) return result;

  /**
   * ANOTHER DIALECT'S CALL IS STILL A CALL — take it, do not merely warn about it.
   *
   * The served model is learned from an ASYNCHRONOUS status probe, deliberately never awaited so a
   * probe cannot put latency in front of a generation. The cost was a race nobody could see: on a fast
   * run the first round is generated and PARSED before the probe lands, so it is read by the gemma
   * default. A reply in the real model's format then parses to nothing, is treated as a final answer,
   * and its tool call is printed at the operator as prose. Same build, same prompt, different outcome
   * depending on which finished first — which is exactly why this looked intermittent.
   *
   * This block already knew: it computed that another dialect WOULD parse it, logged a warning nobody
   * reads mid-turn, and threw the result away. Using it costs nothing and closes the race for good,
   * whatever the probe is doing. Each dialect requires its own tags, so a prose reply does not become
   * a tool call by being offered to more parsers.
   */
  for (const other of DIALECTS) {
    if (other.id === active.id) continue;
    let alt: ParseAllResult | null = null;
    try { alt = other.parse(raw); } catch { continue; }
    if (!alt || alt.toolCalls.length === 0) continue;
    const pair = `${active.id}<-${other.id}`;
    if (!mismatchWarned.has(pair)) {
      mismatchWarned.add(pair);
      log('WARN', 'adapter_format_mismatch', {
        active: active.id,
        looksLike: other.id,
        calls: String(alt.toolCalls.length),
        model: cachedModelId || '(unknown)',
        forced: String(adapterOverride !== ''),
        recovered: 'true',
        hint: `the reply carried ${other.id}-shaped tool calls; the ${active.id} adapter could not read `
          + `them and they were parsed with ${other.id} instead. /model auto matches on the served model.`,
      });
    }
    return alt;
  }
  return result;
}
export function renderToolCall(call: ParsedToolCall): string { return activeDialect().renderToolCall(call); }
/**
 * THE FINISHED-REPLY MARKER SURVIVES A TOOL TURN — or it costs a round, every task.
 *
 * `$` is instructed in the system prompt, and glm-4.7-flash obeys it in a plain turn. Declare
 * `tools` on the request and it stops: Ollama's built-in renderer for that architecture injects its own
 * tool-use scaffolding and the model answers inside that frame. Measured, one-shot, same history:
 *
 *   after a tool result, tools NOT declared  ->  "$ 42 files are in /tmp."
 *   after a tool result, tools declared      ->  "There are 42 files in /tmp."      (no marker)
 *   ... plus the rule re-stated on the result ->  "$ There are 42 files in /tmp."
 *
 * A reply with no marker and no tool call is read as work-in-progress, so the loop nudges and spends a
 * whole extra generation being told the same answer again. Forty characters on the tool result buys
 * that round back. NATIVE MODE ONLY: prompt mode carries the format in the system prompt already and
 * must not pay for it twice.
 */
export function renderToolResult(body: string): string {
  const rendered = activeDialect().renderToolResult(body);
  if (toolMode() !== 'native') return rendered;
  return `${rendered}\n\n${getPrompt('finalMarkerReminder')}`;
}

// ── Generation façade (model-agnostic; served by the active provider) ──
// Both wrap the call in the WAIT NARRATOR (wait-narrator.ts), so any wait — a model swap, a
// single-slot queue, or generation itself — is reported on the thinking line instead of an
// indistinguishable "Thinking··" (the narrator stands down when the provider reports no queue).
// This is the one place every ayin LLM call passes through, so wiring it here covers the agent
// loop, goal derivation, judges and summaries at once.
/**
 * Observers of every model call. The counterpart to `addLogSink`: side software connects here to
 * monitor what the agent is actually spending on the GPU — model, prompt size, duration, failure —
 * without ayin knowing anything about the collector.
 *
 * Registered here on purpose. This is the ONE function in ayin that reaches the provider to generate,
 * so a hook in it cannot be bypassed: the agent loop, goal derivation, judges, summaries and every
 * tool's delegate all pass through this line. A hook anywhere else would be a hook with holes.
 */
export interface LlmCallRecord {
  model: string;
  /** Characters in, not tokens — the number available without a tokenizer, and honest about that. */
  promptChars: number;
  replyChars: number;
  ms: number;
  /** How tools were declared for this call; `native` means the prompt carried no catalogue. */
  toolMode: 'native' | 'prompt';
  error?: string;
}

export type LlmSink = (record: LlmCallRecord) => void;

const llmSinks = new Set<LlmSink>();

/** Subscribe to every model call. Returns an unsubscribe. A throwing sink is ignored, never fatal. */
export function addLlmSink(sink: LlmSink): () => void {
  llmSinks.add(sink);
  return () => { llmSinks.delete(sink); };
}

export function llmSinkCount(): number { return llmSinks.size; }

function emitLlmCall(record: LlmCallRecord): void {
  for (const sink of llmSinks) {
    // A monitor must never be able to fail a generation that already succeeded.
    try { sink(record); } catch { /* ignore */ }
  }
}

export interface LlmChatOptions {
  /**
   * Declare the tool catalogue to the model. TRUE for the agent loop; FALSE for anything asking the
   * model a question and expecting an ANSWER.
   *
   * This defaulted to always-on, and against a native provider it was the whole bug. `explore` sends
   * "you have no tools, reply with JSON" — and ayin declared `grep`, `read_file` and the rest through
   * the API on the same request. GPT-4.1 did the correct thing with a real tool it had genuinely been
   * given: it called it. `renderToolCalls` then turned that into ayin's XML text, which arrived in
   * explore's reply as `<function=grep><parameter=pattern>…` and parsed as nothing.
   *
   * The model was never confused and never hallucinating. It was handed a tool and used it. A sub-loop
   * that wants prose or JSON must not be declaring tools at all.
   */
  declareTools?: boolean;
}

/**
 * WHAT THE LAST CALL COST, and what the material added since the one before it cost.
 *
 * Both numbers come from the server (`prompt_eval_count` / `eval_count`, or OpenAI's `usage`) — nothing
 * here estimates. `growth` is the interesting one and it is a SUBTRACTION OF EXACT NUMBERS, not a guess:
 *
 *     growth = in(n) − in(n−1) − out(n−1)
 *
 * Between two rounds of one turn the prompt gains exactly two things: the model's own previous reply
 * (`out(n−1)`, known exactly) and whatever ayin appended — a tool result. Subtracting the reply leaves the
 * price of that tool result, in the tokenizer of the model that actually read it, without ayin shipping a
 * tokenizer or spending a second call to count. It is null when there is no previous call, and when the
 * result is negative — a trimmed or compacted window means the arithmetic no longer describes an addition,
 * and a wrong number here is worse than none.
 */
export interface TurnUsage {
  in: number;
  out: number;
  growth: number | null;
  /**
   * True for a round of the AGENT LOOP, false for a sub-call (a connector loop, the critic, explore,
   * a QA pass). Only a main-loop round has a prompt that is "the previous prompt plus what ayin
   * appended", so only its growth means anything — and only its cost belongs on a chat message. A
   * sub-call is still reported, because the log wants every call, but it prices nothing on screen.
   */
  main: boolean;
}

let _lastUsage: TurnUsage | null = null;
let _prev: { in: number; out: number } | null = null;
let _usageHook: ((u: TurnUsage) => void) | null = null;

/**
 * HOW MANY CHARACTERS THIS MODEL PUTS IN A TOKEN, learned from it rather than assumed.
 *
 * Every budget in the agent divides characters by a constant 3 to guess tokens. Measured against the
 * server's own count on this workload the guess runs ~40% high — 21,209 characters of prompt that the
 * constant calls 7,054 tokens are 5,037 tokens in fact. Guessing high is the safe direction and it is
 * still a 30% haircut on every window the agent thinks it has, applied to a window that is already
 * mostly empty.
 *
 * The exact ratio is free: `promptChars` is known before the call and `prompt_eval_count` comes back
 * with the reply. So it is measured, not tuned.
 *
 * WHAT IS REJECTED, AND WHY EACH ONE WOULD LIE:
 *   · sub-calls — a critic prompt is prose and a round is source code, and they tokenize differently.
 *     This number is spent budgeting the MAIN loop's window, so only main rounds may set it.
 *   · short prompts — the ratio is dominated by the chat template's own tokens below a few thousand
 *     characters.
 *   · anything outside 2.5–5.5 — an implausible ratio is not a dense prompt, it is a call whose
 *     characters do not describe its tokens. A vision call is the real case: the image is not in
 *     `promptChars` at all, so the ratio collapses toward zero. Rejected rather than clamped, so one
 *     screenshot cannot drag the average it is not evidence about.
 *
 * Averaged over the last few accepted samples so one dense grep result cannot move it far, and reset
 * with the model — a different tokenizer is a different number, and carrying the old one is the same
 * class of bug as carrying the old window.
 */
const RATIO_FALLBACK = 3;
const RATIO_MIN = 2.5;
const RATIO_MAX = 5.5;
const RATIO_MIN_CHARS = 2_000;
const RATIO_MIN_SAMPLES = 3;
const RATIO_WINDOW = 8;
let ratioAvg = 0;
let ratioSamples = 0;

/**
 * Characters per token for the live model, or the pessimistic constant until it is known.
 *
 * NEVER extrapolated from one call: three accepted samples are required, because the first prompt of a
 * session is the most atypical one there is — almost entirely the fixed prefix.
 */
export function charsPerToken(): number {
  return ratioSamples >= RATIO_MIN_SAMPLES && ratioAvg > 0 ? ratioAvg : RATIO_FALLBACK;
}

/** For the debug manifest and the gate: is this measured yet, and from how many calls? */
export function tokenRatio(): { charsPerToken: number; samples: number; measured: boolean } {
  const measured = ratioSamples >= RATIO_MIN_SAMPLES && ratioAvg > 0;
  return { charsPerToken: measured ? ratioAvg : RATIO_FALLBACK, samples: ratioSamples, measured };
}

export function resetTokenRatio(): void {
  ratioAvg = 0;
  ratioSamples = 0;
}

export function noteTokenRatio(promptChars: number, tokensIn: number, main: boolean): void {
  if (!main || tokensIn <= 0 || promptChars < RATIO_MIN_CHARS) return;
  const r = promptChars / tokensIn;
  if (r < RATIO_MIN || r > RATIO_MAX) {
    log('DEBUG', 'token_ratio_rejected', { ratio: r.toFixed(2), chars: String(promptChars), tokens: String(tokensIn) });
    return;
  }
  const n = Math.min(RATIO_WINDOW, ratioSamples + 1);
  ratioAvg = ratioSamples === 0 ? r : ratioAvg + (r - ratioAvg) / n;
  ratioSamples++;
  if (ratioSamples === RATIO_MIN_SAMPLES) {
    log('INFO', 'token_ratio_measured', { charsPerToken: ratioAvg.toFixed(2), was: String(RATIO_FALLBACK) });
  }
}

/** Subscribe to per-call usage. The UI registers this; nothing in `llm/` may import the UI. */
export function onLlmUsage(fn: (u: TurnUsage) => void): void {
  _usageHook = fn;
}

export function lastUsage(): TurnUsage | null {
  return _lastUsage;
}

/** A new turn: the next call's prompt is not this turn's previous prompt plus a tool result. */
export function resetUsageBaseline(): void {
  _prev = null;
}

/**
 * The arithmetic, as a pure function so it can be asserted without a model (`npm run check:cost`).
 *
 * `prev` is the previous MAIN-loop call. Growth is only meaningful between two rounds of one turn, and
 * only when it comes out positive — a trimmed or compacted window makes the subtraction describe
 * something other than an addition, and a wrong number is worse than none.
 */
export function computeUsage(
  prev: { in: number; out: number } | null,
  u: { in: number; out: number },
  purpose: string,
): TurnUsage {
  // `setLlmPurpose('round N · model')` marks a turn round; everything else defaults to `sub-call`.
  const main = /^round \d+/.test(purpose);
  const raw = main && prev && u.in > 0 ? u.in - prev.in - prev.out : null;
  return { in: u.in, out: u.out, growth: raw !== null && raw >= 0 ? raw : null, main };
}

function recordUsage(u: { in: number; out: number }, purpose: string, promptChars = 0): void {
  const usage = computeUsage(_prev, u, purpose);
  _lastUsage = usage;
  // The one place both numbers for the SAME call are in scope. Anywhere else would be pairing a
  // character count with some other call's token count.
  noteTokenRatio(promptChars, u.in, usage.main);
  // Only a round advances the baseline. A connector's inner loop has its own prompt entirely, and
  // letting it set the baseline made the next round's "growth" a subtraction of two unrelated prompts.
  if (usage.main) _prev = { in: u.in, out: u.out };
  log('INFO', 'llm_usage', { purpose, in: String(u.in), out: String(u.out), growth: String(usage.growth ?? '') });
  try { _usageHook?.(usage); } catch { /* a display must never break a turn */ }
}

export async function llmChat(messages: LlmMessage[], opts: LlmChatOptions = {}): Promise<string> {
  // EVERY model call is measured here, at the one funnel they all pass through. Wrapping callers
  // instead left the critic, the arbiters, the goal derivation and every connector loop unmeasured.
  const purpose = takeLlmPurpose();
  return timed('llm', purpose, () => llmChatInner(messages, opts, purpose));
}

async function llmChatInner(messages: LlmMessage[], opts: LlmChatOptions = {}, purpose = 'sub-call'): Promise<string> {
  ensureRefreshed();
  // Declare the tools. A provider that can pass them to the runtime (providers/ollama.ts) gets native
  // tool-calling — the model emits the syntax it was trained on and the runtime parses it — while the
  // text-contract providers ignore the field and nothing changes for them.
  const provider = await llmProvider();
  // Schemas go out ONLY to a provider that declares them AND to a caller that wants them; a text
  // contract provider would ignore the field, and sending it anyway invites exactly the
  // double-declaration this mode exists to prevent.
  //
  // `toolMode()`, NOT `provider.tools` — ONE SOURCE OF TRUTH. The provider states what it is willing
  // to do; `toolMode()` is that claim after reconciling it against the model actually resident, and it
  // can only ever be downgraded (see `reconcileToolMode`). Reading the raw claim here while the system
  // prompt read the reconciled one split the decision in two, and the halves disagreed: the prompt
  // omitted the tool catalogue because the mode said native, while this line still declared schemas to
  // a model whose format cannot carry them — so the model emitted canonical XML that its own server
  // could not parse, and the whole turn came back as unparsed text with zero tool calls.
  //
  // TWO DIFFERENT QUESTIONS, and conflating them cost every prompt-mode install its tool calls.
  //
  //   offersTools — does this CALL have tools at all? Only the caller knows. The agent loop does; a
  //                 sub-loop asking for JSON does not, and says so with `declareTools: false`.
  //   declared    — were the schemas handed to the RUNTIME? That is a transport question, and in
  //                 prompt mode the answer is always no because the catalogue rides in the system
  //                 prompt instead.
  //
  // The guard below used `declared`, so against any text-contract endpoint it fired on EVERY round of
  // the agent loop: the model emitted a perfectly good `<function=read_file>`, ayin parsed it, threw
  // it away, and told the model it had no tools. Measured on gemma4:26b — three valid calls in three
  // rounds, all discarded, and the turn ended with "I cannot answer because no task was provided".
  const offersTools = opts.declareTools !== false;
  const declared = toolMode() === 'native' && offersTools;
  const tools = declared
    ? await (async () => {
        // Reached from any generate path, not only a turn, so it insists on discovery rather than
        // assuming the agent loop ran first.
        const reg = await import('../tools.js');
        await reg.loadTools();
        // The SAME list the prompt catalogue uses — a tool offered natively but hidden from the
        // prompt (or the reverse) is a contract the model cannot satisfy.
        return reg.modelTools().map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters.map((p) => ({ name: p.name, type: p.type, description: p.description, required: p.required })),
        }));
      })()
    : undefined;
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  const started = Date.now();
  try {
    let reply = await narrateWait('thinking', async () => {
      const r = await provider.generate(messages, tools ? { tools } : undefined);
      if (r.usage) recordUsage(r.usage, purpose, promptChars);
      return r.content;
    });

    // A TOOL-TRAINED MODEL ANSWERS WITH A TOOL CALL EVEN WHEN IT HAS NONE.
    //
    // `declareTools: false` stops ayin from OFFERING it tools; it cannot stop the model from reaching
    // for one. It fires on that flag and nothing else — a call that does offer tools, however they are
    // transported, must keep the call the model made. qwen3-coder emits `<function=grep><parameter=…>` for "find the files that…" because
    // that is what it was trained to do, and the sub-loop that asked — explore, indulge, the QA
    // audit — wanted JSON and gets something that parses to nothing. The iteration is then thrown
    // away, which on a metered model is an iteration the operator paid for.
    //
    // Handled HERE rather than in each caller: the dialect layer is what knows how a model formats a
    // tool call, and one fix serves explore, indulge, plan, QA and every connector. A patch in
    // explore would have left the others to meet this separately and solve it separately — which is
    // exactly what happened before, and had to be reverted.
    //
    // ONE retry, then whatever comes back is returned. A guard that can loop is worse than the
    // behaviour it corrects, and a model that insists twice is telling you something the loop should
    // surface rather than hide.
    if (!offersTools && activeDialect().parse(reply).toolCalls.length > 0) {
      log('INFO', 'tool_call_without_tools', { model: cachedModelId, dialect: activeDialect().id });
      // The raw text, on disk. This is the reply that settles "did the model emit that, or did ayin
      // mangle it" — and it was previously kept nowhere unless /transcribe had been switched on
      // beforehand, which nobody does before the bug they did not expect.
      void import('../session-record.js').then((r) => r.recordRaw(0, `tool call with no tools declared · dialect ${activeDialect().id} · model ${cachedModelId || 'unknown'}`, reply));
      // THE RETRY IS SHORT. It used to re-send the ENTIRE conversation — measured on the gateway at
      // 16,818 prompt tokens and 91 seconds, for a correction whose whole content is "you cannot call
      // tools here". The instruction that was already given is in the system message; the only new
      // fact is the reply that broke the rule. Sending the middle again buys nothing and costs the
      // slowest call in the turn.
      const head = messages.find((m) => m.role === 'system');
      const retry = await narrateWait('thinking', async () => (await provider.generate([
        ...(head ? [head] : []),
        { role: 'assistant', content: reply },
        { role: 'user', content:
          'This request declared no tools and there is nothing to call — a tool call cannot be run '
          + 'and is discarded. Answer directly, in exactly the format the instructions asked for. '
          + 'If you need something you would have used a tool for, say what and why instead.' },
      ], undefined)).content);
      if (retry.trim()) reply = retry;
    }
    emitLlmCall({
      model: cachedModelId, promptChars, replyChars: reply.length,
      ms: Date.now() - started, toolMode: declared ? 'native' : 'prompt',
    });
    return reply;
  } catch (err) {
    // A failed call is the one an observer most wants; reported, then rethrown unchanged.
    emitLlmCall({
      model: cachedModelId, promptChars, replyChars: 0,
      ms: Date.now() - started, toolMode: declared ? 'native' : 'prompt',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
/**
 * One question, one answer. NEVER offers tools — there is no system prompt here, so there is no
 * catalogue and no schemas, and a call that cannot run is a wasted round whichever way it arrives.
 * Every caller (goal derivation, the summary, plan triage, the agent's own sub-question) wants prose
 * or JSON back, so the flag belongs here rather than repeated at each of them.
 */
export async function llmCall(prompt: string): Promise<string> {
  return llmChat([{ role: 'user', content: prompt }], { declareTools: false });
}
