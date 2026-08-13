/**
 * web_search — in-process web search. No key, no container, no dependency: a clone of ayin can
 * search the web the moment it is built.
 *
 * ENGINE ORDER
 *   1. **SearXNG**, and ONLY when explicitly configured (`/set searxng-url`, `AYIN_SEARXNG_URL`).
 *      Self-hosting a metasearch instance is the right answer for anyone who searches a lot — it is
 *      not rate-limited and aggregates several engines — but it is an upgrade, never a requirement.
 *   2. **DuckDuckGo**, the keyless default: the `html` endpoint, then `lite` if that is challenged.
 *   3. **DuckDuckGo Instant Answer** — last resort when nothing ranks.
 * Rank → dedup → fetch the top pages → strip to readable text → merged markdown digest. The
 * agentic loop's model is the synthesizer (it reads this digest and answers) — no summarizer here.
 *
 * THE FAILURE THAT MATTERS IS THE SILENT ONE. DDG answers a scraper it dislikes with **HTTP 202** and
 * a challenge page — and 202 passes `res.ok`, so the natural code reads it as a page with no results
 * and reports "No web results". Measured over 10 rapid requests: 7 real, 3 challenged, the challenges
 * clustering at the end as the rate limit engaged. An agent told "no results" concludes the web is
 * empty and moves on; an agent told "you are being rate-limited" tries again or asks for SearXNG. So a
 * challenge is detected, retried on the other endpoint, never cached, and reported as what it is.
 *
 * Dependency-free: SearXNG is a JSON call; the DDG HTML + page extraction use regex, not cheerio.
 */


import { toolLog, toolConfig } from './runtime.js';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 10_000;
const PER_SOURCE_CHARS = 1800;
const MAX_URLS = 4;
const CACHE_TTL_MS = 15 * 60 * 1000;

const cache = new Map<string, { result: string; expires: number }>();

interface SearchResult { title: string; url: string; snippet: string; engine: string }
interface RankedResult extends SearchResult { score: number }

/**
 * SearXNG base URL — EXPLICIT ONLY, '' when unconfigured.
 *
 * This used to fall back to `<llm-host>:8888`, guessing that a metasearch container sits beside the
 * model endpoint. That is one deployment's topology, not a fact about anyone else's machine: a clone
 * would dial a port on the user's LLM host on every search, and against a host that drops packets
 * rather than refusing them, pay the full 12s timeout before reaching the engine that works.
 */
function searxngUrl(): string {
  const explicit = process.env.AYIN_SEARXNG_URL || toolConfig('searxngUrl');
  return explicit ? explicit.replace(/\/$/, '') : '';
}

// ── relevance scoring ────────────────────────────────────────────────
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

/**
 * The two keyless DDG endpoints. They share a rate limit but are not perfectly correlated — measured,
 * one query was served by `html` while `lite` was challenged in the same second — so trying the second
 * is worth one request before giving up.
 */
const DDG_ENDPOINTS = [
  'https://html.duckduckgo.com/html/?q=',
  'https://lite.duckduckgo.com/lite/?q=',
];

/** DDG asks scrapers to go away with 202 + a challenge page. 429/403 are the blunter forms. */
function isChallenge(status: number, body: string): boolean {
  return status === 202 || status === 429 || status === 403 || /anomaly-modal|challenge-form/.test(body);
}

/** Requests closer together than this are what trips the rate limit; the gap is cheap insurance. */
const DDG_MIN_GAP_MS = 1_200;
let lastDdgAt = 0;

async function paceDdg(): Promise<void> {
  const wait = lastDdgAt + DDG_MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastDdgAt = Date.now();
}

/** One endpoint. `challenged` is the fact the caller must not lose: it is not the same as no results. */
async function fetchDdg(endpoint: string, query: string): Promise<{ html: string; challenged: boolean }> {
  await paceDdg();
  try {
    const res = await fetch(`${endpoint}${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' },
      signal: AbortSignal.timeout(12_000),
    });
    const body = await res.text();
    if (isChallenge(res.status, body)) return { html: '', challenged: true };
    return { html: res.ok ? body : '', challenged: false };
  } catch {
    return { html: '', challenged: false }; // a network error is not a challenge; do not blame the rate limit
  }
}

/** DEFAULT ENGINE: DuckDuckGo, keyless. Regex-parsed — DDG wraps the real URL in /l/?uddg=. */
async function searchDuckDuckGoHtml(query: string, maxResults = 8): Promise<{ results: SearchResult[]; challenged: boolean }> {
  let html = '';
  let challenged = false;
  for (const endpoint of DDG_ENDPOINTS) {
    const got = await fetchDdg(endpoint, query);
    challenged = got.challenged;
    if (got.html) { html = got.html; challenged = false; break; }
  }

  return { results: parseDdg(html, maxResults), challenged };
}

/**
 * Both endpoints' markup, which differ in every detail that a regex cares about:
 *   html:  <a class="result__a" href="…">                 snippet: class="result__snippet" … </a>
 *   lite:  <a rel="nofollow" href="…" class='result-link'>  snippet: <td class='result-snippet'> … </td>
 * Double vs SINGLE quotes, a snippet closing with `</td>` instead of `</a>`, and — the one that is easy
 * to miss — the attributes in the OPPOSITE ORDER, so one regex demanding class-then-href matches only
 * the first shape. Hence: match every anchor, then interrogate the tag.
 */
export function parseDdg(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const snippetRe = /class=["'][^"']*result(?:__snippet|-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td)>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));

  const anchorRe = /<a\s([^>]*)>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = anchorRe.exec(html)) && results.length < maxResults) {
    const attrs = m[1];
    if (!/class=["'][^"']*result(?:__a|-link)[^"']*["']/.test(attrs)) continue;
    const hrefMatch = attrs.match(/href=["']([^"']*)["']/);
    if (!hrefMatch) continue;
    let href = decodeEntities(hrefMatch[1]);     // lite escapes the redirect's & as &amp;
    if (href.startsWith('//')) href = `https:${href}`;
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

/** SearXNG when configured, else DuckDuckGo. `challenged` survives to the caller — see the header. */
async function searchWeb(query: string): Promise<{ results: SearchResult[]; challenged: boolean }> {
  if (searxngUrl()) {
    const sx = await searchSearxng(query, 8);
    if (sx.length > 0) { toolLog().debug('websearch_searxng', { hits: String(sx.length) }); return { results: sx, challenged: false }; }
  }
  const ddg = await searchDuckDuckGoHtml(query, 8);
  toolLog().debug('websearch_ddg', { hits: String(ddg.results.length), challenged: String(ddg.challenged) });
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

/** `cacheable: false` keeps a rate-limit blip out of the 15-minute cache — see `webSearch`. */
async function search(query: string): Promise<{ text: string; cacheable: boolean }> {
  const terms = extractQueryTerms(query);
  const web = await searchWeb(query);
  const selected = rankAndDedup(web.results, terms, MAX_URLS);

  if (selected.length === 0) {
    const instant = await duckDuckGoInstantAnswer(query);
    if (instant) return { text: `Web search (DuckDuckGo Instant Answer) for "${query}":\n\n${instant}`, cacheable: true };
    // The distinction the agent has to act on: rate-limited is "ask again", empty is "look elsewhere".
    if (web.challenged) {
      return {
        text:
          `Web search for "${query}" was RATE-LIMITED, not empty — DuckDuckGo served a challenge page ` +
          `instead of results, on both its endpoints. This says nothing about whether the answer exists. ` +
          `Wait and retry, or configure a SearXNG instance (\`/set searxng-url <url>\`), which is not ` +
          `rate-limited.`,
        cacheable: false,
      };
    }
    return { text: `No web results for "${query}".`, cacheable: true };
  }

  const digests = await Promise.all(
    selected.map(async (r) => {
      const content = await fetchUrlContent(r.url);
      const body = content && content.length > 100 ? content.slice(0, PER_SOURCE_CHARS) : r.snippet || '(no content)';
      return `### ${r.title}\n${r.url}\n${body}`;
    }),
  );

  const sources = selected.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join('\n');
  return { text: `Web search results for "${query}":\n\n${digests.join('\n\n')}\n\nSources:\n${sources}`, cacheable: true };
}

/**
 * The tool entry point. 15-minute per-query cache — but a rate-limited answer is NOT cached: caching
 * it would turn a few-second block into a quarter-hour of the agent being told the same non-answer,
 * with no request going out to discover the block had lifted.
 */
export async function webSearch(query: string): Promise<string> {
  const q = query.trim();
  if (!q) return 'Error: query required';
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.result;
  const { text, cacheable } = await search(q);
  if (cacheable) cache.set(key, { result: text, expires: Date.now() + CACHE_TTL_MS });
  return text;
}
