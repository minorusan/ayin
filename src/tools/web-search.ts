/**
 * web_search — in-process web search, the SAME pipeline maradel uses
 * (backend/src/tasks/webSearch.ts), minus the Telegram-channel half and the heavy Readability
 * dep. Engine order:
 *   1. **SearXNG** — the keyless, self-hosted SerpApi alternative (metasearch, JSON API), PRIMARY.
 *   2. **DuckDuckGo HTML** — keyless fallback when SearXNG is unreachable / returns nothing.
 *   3. **DuckDuckGo Instant Answer** — last resort when nothing ranks.
 * Rank → dedup → fetch the top pages → strip to readable text → merged markdown digest. The
 * agentic loop's model is the synthesizer (it reads this digest and answers) — no summarizer here.
 *
 * Replaces the old shell-out to `malkhut search` (which isn't installed → the tool was dead).
 * Dependency-free: SearXNG is a JSON call; the DDG HTML + page extraction use regex, not cheerio.
 */

import { keliBaseUrl } from '../connection.js';
import { getConfigString } from '../prompts.js';
import { log } from '../log.js';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 10_000;
const PER_SOURCE_CHARS = 1800;
const MAX_URLS = 4;
const CACHE_TTL_MS = 15 * 60 * 1000;

const cache = new Map<string, { result: string; expires: number }>();

interface SearchResult { title: string; url: string; snippet: string; engine: string }
interface RankedResult extends SearchResult { score: number }

/** SearXNG base URL: env override → /set searxng-url → derived from the KELI backend host on :8888
 *  (the shared metasearch container lives next to the backend, mirroring maradel's default). */
function searxngUrl(): string {
  const explicit = process.env.MARADEL_SEARXNG_URL || process.env.AYIN_SEARXNG_URL || getConfigString('searxngUrl');
  if (explicit) return explicit.replace(/\/$/, '');
  try {
    const u = new URL(keliBaseUrl());
    return `${u.protocol}//${u.hostname}:8888`;
  } catch {
    return 'http://localhost:8888';
  }
}

// ── relevance scoring (ported from maradel) ──────────────────────────
const STOP_WORDS = new Set(
  ('the a an is are was were be been being have has had do does did will would could should may ' +
    'might shall can to of in for on with at by from as into through during before after above below ' +
    'between out off over under again then once here there when where why how all each every both few ' +
    'more most other some such no nor not only own same so than too very and but or if while because ' +
    'until about what which who whom this that these those it its').split(' '),
);

function extractQueryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function scoreRelevance(title: string, snippet: string, terms: string[]): number {
  if (terms.length === 0) return 0.5;
  const t = title.toLowerCase();
  const s = snippet.toLowerCase();
  let th = 0, sh = 0;
  for (const term of terms) { if (t.includes(term)) th++; if (s.includes(term)) sh++; }
  return Math.min((th * 2 + sh) / (terms.length * 3), 1);
}

// ── small HTML helpers (no cheerio) ──────────────────────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ── engines ──────────────────────────────────────────────────────────

/** PRIMARY: SearXNG JSON API. Empty base, non-200 (403 = JSON not enabled), or error → [] (fall back). */
async function searchSearxng(query: string, maxResults = 8): Promise<SearchResult[]> {
  const base = searxngUrl();
  if (!base) return [];
  try {
    const url = new URL(`${base}/search`);
    url.search = new URLSearchParams({ q: query, format: 'json', safesearch: '0' }).toString();
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string; engines?: string[]; engine?: string }> };
    const out: SearchResult[] = [];
    for (const r of data.results ?? []) {
      if (out.length >= maxResults || !r.url) continue;
      const via = r.engines?.length ? r.engines.join('+') : r.engine || 'searxng';
      out.push({ title: r.title ?? '', url: r.url, snippet: r.content ?? '', engine: `searxng:${via}` });
    }
    return out;
  } catch {
    return [];
  }
}

/** FALLBACK: DuckDuckGo HTML endpoint (keyless). Regex-parsed — DDG wraps the real URL in /l/?uddg=. */
async function searchDuckDuckGoHtml(query: string, maxResults = 8): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  let html = '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) html = await res.text();
  } catch { /* give up gracefully */ }

  const results: SearchResult[] = [];
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = anchorRe.exec(html)) && results.length < maxResults) {
    let href = m[1];
    const uddg = href.match(/[?&]uddg=([^&]+)/); // unwrap DDG's redirect
    if (uddg) href = decodeURIComponent(uddg[1]);
    const title = stripTags(m[2]);
    if (title && /^https?:\/\//.test(href)) {
      results.push({ title, url: href, snippet: snippets[idx] ?? '', engine: 'duckduckgo' });
    }
    idx++;
  }
  return results;
}

async function duckDuckGoInstantAnswer(query: string): Promise<string | null> {
  try {
    const url = new URL('https://api.duckduckgo.com/');
    url.search = new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1' }).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const d = (await res.json()) as { AbstractText?: string; Answer?: string; Definition?: string };
    return d.AbstractText || d.Answer || d.Definition || null;
  } catch {
    return null;
  }
}

/** The web half: SearXNG first, DuckDuckGo HTML when it's empty/unreachable. */
async function searchWeb(query: string): Promise<SearchResult[]> {
  const sx = await searchSearxng(query, 8);
  if (sx.length > 0) { log('DEBUG', 'websearch_searxng', { hits: String(sx.length) }); return sx; }
  const ddg = await searchDuckDuckGoHtml(query, 8);
  log('DEBUG', 'websearch_ddg_fallback', { hits: String(ddg.length) });
  return ddg;
}

async function fetchUrlContent(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return '';
    if (Number(res.headers.get('content-length') ?? 0) > 3 * 1024 * 1024) return ''; // skip huge pages
    const html = await res.text();
    // Lean readable extraction (no jsdom/Readability): drop scripts/styles/comments, strip tags.
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ');
    return stripTags(cleaned).slice(0, 20_000);
  } catch {
    return '';
  }
}

/** Rank + dedup the web hits (by URL and by leading snippet text). */
function rankAndDedup(web: SearchResult[], terms: string[], maxResults: number): RankedResult[] {
  const scored: RankedResult[] = web
    .map((r) => ({ ...r, score: scoreRelevance(r.title, r.snippet, terms) }))
    .filter((r) => r.score >= 0.2);
  const seenUrl = new Set<string>();
  const seenText = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((r) => {
      if (seenUrl.has(r.url)) return false;
      const textKey = r.snippet.trim().slice(0, 200).toLowerCase();
      if (textKey && seenText.has(textKey)) return false;
      seenUrl.add(r.url);
      if (textKey) seenText.add(textKey);
      return true;
    })
    .slice(0, maxResults);
}

async function search(query: string): Promise<string> {
  const terms = extractQueryTerms(query);
  const selected = rankAndDedup(await searchWeb(query), terms, MAX_URLS);

  if (selected.length === 0) {
    const instant = await duckDuckGoInstantAnswer(query);
    if (instant) return `Web search (DuckDuckGo Instant Answer) for "${query}":\n\n${instant}`;
    return `No web results for "${query}".`;
  }

  const digests = await Promise.all(
    selected.map(async (r) => {
      const content = await fetchUrlContent(r.url);
      const body = content && content.length > 100 ? content.slice(0, PER_SOURCE_CHARS) : r.snippet || '(no content)';
      return `### ${r.title}\n${r.url}\n${body}`;
    }),
  );

  const sources = selected.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join('\n');
  return `Web search results for "${query}":\n\n${digests.join('\n\n')}\n\nSources:\n${sources}`;
}

/** The tool entry point. 15-minute per-query cache (identical to maradel). */
export async function webSearch(query: string): Promise<string> {
  const q = query.trim();
  if (!q) return 'Error: query required';
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.result;
  const result = await search(q);
  cache.set(key, { result, expires: Date.now() + CACHE_TTL_MS });
  return result;
}
