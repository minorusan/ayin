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
 * (gemma by default). Call on connect, and whenever the backend may have swapped
 * the served model.
 */
export async function refreshActiveModel(): Promise<void> {
  refreshKicked = true;
  try {
    const s = await (await llmProvider()).status();
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
export function toolCallInstructions(): string { return activeDialect().toolCallInstructions(); }
export function parseToolCalls(raw: string): ParseAllResult { return activeDialect().parse(raw); }
export function renderToolCall(call: ParsedToolCall): string { return activeDialect().renderToolCall(call); }
export function renderToolResult(body: string): string { return activeDialect().renderToolResult(body); }

// ── Generation façade (model-agnostic; served by the active provider) ──
// Both wrap the call in the WAIT NARRATOR (wait-narrator.ts), so any wait — a model swap, a
// single-slot queue, or generation itself — is reported on the thinking line instead of an
// indistinguishable "Thinking··" (the narrator stands down when the provider reports no queue).
// This is the one place every ayin LLM call passes through, so wiring it here covers the agent
// loop, goal derivation, judges and summaries at once.
export async function llmChat(messages: LlmMessage[]): Promise<string> {
  ensureRefreshed();
  return narrateWait('thinking', async () => (await (await llmProvider()).generate(messages)).content);
}
export async function llmCall(prompt: string): Promise<string> {
  return llmChat([{ role: 'user', content: prompt }]);
}
