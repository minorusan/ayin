/**
 * docs_search tool — semantic retrieval over Maradel's own documentation.
 *
 * Calls the Maradel backend's POST /api/docs/search (the same daemon that serves /api/generate),
 * which embeds CLAUDE.md + docs/*.md with nomic + sqlite-vec and returns the most relevant sections.
 * This is the docs/prose counterpart to grep/explore (which stay the path for CODE). Endpoint chosen
 * via KELI_URL, identical to connection.ts.
 */

import { log } from '../log.js';
import { addMessage } from '../ui.js';
import { keliBaseUrl } from '../connection.js';

interface DocHit {
  source: string;
  heading: string;
  text: string;
  score: number;
}

export async function docsSearchExecute(params: Record<string, string>): Promise<string> {
  const query = params.query;
  if (!query) return 'Error: query required';
  const k = params.k ? Math.max(1, Math.min(20, parseInt(params.k, 10) || 6)) : 6;

  addMessage('system', `Searching Maradel docs: ${query.substring(0, 80)}...`);
  log('INFO', 'docs_search_start', { query: query.substring(0, 100), k: String(k) });

  const base = keliBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/api/docs/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, k }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return `Error: docs_search could not reach the Maradel backend at ${base} (${e instanceof Error ? e.message : String(e)})`;
  }

  if (!res.ok) {
    const body = await res.text();
    return `Error: docs_search ${res.status}: ${body.substring(0, 300)}`;
  }

  const data = (await res.json()) as { results?: DocHit[] };
  const hits = data.results ?? [];
  if (hits.length === 0) return 'No matching documentation sections found.';

  log('INFO', 'docs_search_done', { hits: String(hits.length) });
  return hits
    .map((h) => {
      const cite = h.heading ? `${h.source} › ${h.heading}` : h.source;
      return `[${cite}] (relevance ${(h.score * 100).toFixed(0)}%)\n${h.text}`;
    })
    .join('\n\n---\n\n');
}
