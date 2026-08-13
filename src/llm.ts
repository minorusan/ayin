/**
 * LLM — re-exports llmCall from the Ayin LLM manager (the single seam for all
 * LLM access). Separate module so components can import without circular deps.
 */

export { llmCall } from './llm/manager.js';
