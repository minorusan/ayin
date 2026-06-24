/**
 * LLM — re-exports llmCall from connection.
 * Separate module so components can import without circular deps.
 */

export { llmCall } from './connection.js';
