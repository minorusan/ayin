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
import type { LlmMessage, ModelDialect, ParseAllResult, ParsedToolCall } from './types.js';
import { GemmaDialect } from './dialects/gemma.js';
import { QwenDialect } from './dialects/qwen.js';
import { narrateWait } from '../wait-narrator.js';
import { llmProvider } from './select.js';

// Registered dialects, in match-priority order. The first whose matches() returns
// true for the active model wins; DEFAULT is used until the model id is known.
const DIALECTS: ModelDialect[] = [new QwenDialect(), new GemmaDialect()];
const DEFAULT: ModelDialect = DIALECTS[DIALECTS.length - 1]; // gemma — used until the model id is known

let cachedModelId = '';
let cachedDialect: ModelDialect = DEFAULT;
let refreshKicked = false;

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

/** Fire a one-time background model refresh on first use (best-effort). */
function ensureRefreshed(): void {
  if (refreshKicked) return;
  refreshKicked = true;
  void refreshActiveModel();
}

/**
 * Refresh the active model id from the backend (GET /api/status → {model}) and
 * re-resolve the dialect. Non-fatal: on any failure the current dialect is kept
 * (gemma by default). Call on connect, and whenever the backend may have swapped
 * the served model.
 */
export async function refreshActiveModel(): Promise<void> {
  refreshKicked = true;
  try {
    const provider = await llmProvider();
    const mode = provider.tools ?? 'prompt';
    if (mode !== cachedToolMode) {
      cachedToolMode = mode;
      log('INFO', 'tool_declaration_mode', { provider: provider.name, mode });
    }
    const s = await provider.status();
    const modelId = s.ok ? String(s.model ?? '') : '';
    if (!modelId || modelId === cachedModelId) return;
    cachedModelId = modelId;
    const next = pickDialect(modelId);
    if (next.id !== cachedDialect.id) {
      log('INFO', 'llm_dialect_switch', { model: modelId, dialect: next.id });
    }
    cachedDialect = next;
  } catch { /* unreachable backend — keep current dialect */ }
}

/** The dialect for the currently-active backend model (sync; uses the last refresh). */
export function activeDialect(): ModelDialect {
  ensureRefreshed();
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
export function parseToolCalls(raw: string): ParseAllResult {
  const active = activeDialect();
  const result = active.parse(raw);
  if (result.toolCalls.length > 0 || raw.trim().length < 20) return result;

  for (const other of DIALECTS) {
    if (other.id === active.id) continue;
    let wouldParse = 0;
    try { wouldParse = other.parse(raw).toolCalls.length; } catch { continue; }
    if (wouldParse === 0) continue;
    const pair = `${active.id}<-${other.id}`;
    if (mismatchWarned.has(pair)) break;
    mismatchWarned.add(pair);
    log('WARN', 'adapter_format_mismatch', {
      active: active.id,
      looksLike: other.id,
      calls: String(wouldParse),
      model: cachedModelId || '(unknown)',
      forced: String(adapterOverride !== ''),
      hint: `the reply carries ${other.id}-shaped tool calls that the ${active.id} adapter cannot read — `
        + `/model ${other.id}, or /model auto to match on the served model`,
    });
    break;
  }
  return result;
}
export function renderToolCall(call: ParsedToolCall): string { return activeDialect().renderToolCall(call); }
export function renderToolResult(body: string): string { return activeDialect().renderToolResult(body); }

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

export async function llmChat(messages: LlmMessage[]): Promise<string> {
  ensureRefreshed();
  // Declare the tools. A provider that can pass them to the runtime (providers/ollama.ts) gets native
  // tool-calling — the model emits the syntax it was trained on and the runtime parses it — while the
  // text-contract providers ignore the field and nothing changes for them.
  const provider = await llmProvider();
  // Schemas go out ONLY to a provider that declares them; a text-contract provider would ignore the
  // field, and sending it anyway invites exactly the double-declaration this mode exists to prevent.
  const declared = (provider.tools ?? 'prompt') === 'native';
  const tools = declared
    ? await (async () => {
        // Reached from any generate path, not only a turn, so it insists on discovery rather than
        // assuming the agent loop ran first.
        const reg = await import('../tools.js');
        await reg.loadTools();
        return reg.getAllTools().map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters.map((p) => ({ name: p.name, type: p.type, description: p.description, required: p.required })),
        }));
      })()
    : undefined;
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  const started = Date.now();
  try {
    const reply = await narrateWait('thinking', async () => (await provider.generate(messages, tools ? { tools } : undefined)).content);
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
export async function llmCall(prompt: string): Promise<string> {
  return llmChat([{ role: 'user', content: prompt }]);
}
