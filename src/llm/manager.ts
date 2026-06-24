/**
 * Ayin LLM manager — the single seam between ayin's model-AGNOSTIC agent loop
 * and the model-FAMILY-specific surface (tool-call format, parsing, result
 * framing). Every LLM call ayin makes goes through here:
 *
 *     ayin tool / agent loop
 *          │  llmChat / llmCall            (transport: messages → text)
 *          ▼
 *     manager ── resolves the ACTIVE model (gemma ↔ qwen-coder, set by whoever
 *          │      owns the maradel `llm` resource) → picks the matching dialect
 *          ▼
 *     dialect ── toolCallInstructions (→ system prompt) · parse(raw)
 *                · renderToolCall · renderToolResult
 *
 * The transport itself (retries, image attach, OpenAI fallback) lives in
 * connection.ts and is model-agnostic; the manager re-exports it so every caller
 * imports LLM access from ONE place. Add a model family by implementing
 * ModelDialect (see types.ts) and registering it in DIALECTS below.
 * See docs/CODE_AGENT.md "Ayin LLM manager".
 */

import { keliBaseUrl, llmChat as transportChat, llmCall as transportCall } from '../connection.js';
import { log } from '../log.js';
import type { LlmMessage, ModelDialect, ParseAllResult, ParsedToolCall } from './types.js';
import { GemmaDialect } from './dialects/gemma.js';
import { QwenDialect } from './dialects/qwen.js';

// Registered dialects, in match-priority order. The first whose matches() returns
// true for the active model wins; DEFAULT is used until the model id is known.
const DIALECTS: ModelDialect[] = [new QwenDialect(), new GemmaDialect()];
const DEFAULT: ModelDialect = DIALECTS[DIALECTS.length - 1]; // gemma — maradel's default model

let cachedModelId = '';
let cachedDialect: ModelDialect = DEFAULT;
let refreshKicked = false;

function pickDialect(modelId: string): ModelDialect {
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
 * (gemma by default). Call on connect, and whenever the model may have swapped
 * (the `llm` resource flips gemma ↔ qwen-coder on ownership changes).
 */
export async function refreshActiveModel(): Promise<void> {
  refreshKicked = true;
  try {
    const res = await fetch(`${keliBaseUrl()}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    const data = await res.json() as { model?: string };
    const modelId = String(data.model ?? '');
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
export function toolCallInstructions(): string { return activeDialect().toolCallInstructions(); }
export function parseToolCalls(raw: string): ParseAllResult { return activeDialect().parse(raw); }
export function renderToolCall(call: ParsedToolCall): string { return activeDialect().renderToolCall(call); }
export function renderToolResult(body: string): string { return activeDialect().renderToolResult(body); }

// ── Transport façade (model-agnostic; implemented in connection.ts) ──
export async function llmChat(messages: LlmMessage[]): Promise<string> {
  ensureRefreshed();
  return transportChat(messages);
}
export async function llmCall(prompt: string): Promise<string> {
  ensureRefreshed();
  return transportCall(prompt);
}
