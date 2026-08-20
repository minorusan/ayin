/**
 * web-markdown.ts — markdown → HTML, for the pages ayin serves.
 *
 * `markdown.ts` already converts markdown, but to BLESSED TAGS for a terminal. Its output is
 * `{bold}…{/bold}`, which in a browser is literal text. Two renderers for one syntax is the cost of
 * two very different targets; the alternative was emitting HTML into the TUI, which is worse.
 *
 * ESCAPE FIRST, FORMAT SECOND, ALWAYS IN THAT ORDER. Everything here renders text a MODEL wrote about
 * a codebase, so it routinely contains `<`, `>`, `&` and whole HTML fragments quoted from source. If
 * formatting ran first, the tags it produced would then be escaped and shown as literal text; if
 * escaping ran second over the result, an `&` from the source would corrupt the tags. So the raw text
 * is escaped once at the top and every rule below operates on already-safe text, inserting only tags
 * it knows are complete.
 *
 * DELIBERATELY SMALL. Headings, fenced and inline code, bold, italic, links, bullet and numbered
 * lists, blockquotes, paragraphs. No tables, no images, no HTML passthrough — passthrough is the one
 * feature that would turn a model's prose into a way to inject markup into a page the operator trusts.
 */

/** The only escape in this file. Runs before any rule, on the whole input. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Inline rules, applied to one already-escaped line.
 *
 * Code spans are extracted FIRST and parked as placeholders, because the text inside them must not
 * then be read as bold or italic — `` `a * b * c` `` is code containing asterisks, not code with
 * emphasis in it.
 *
 * THE PLACEHOLDER IS ANGLE-DELIMITED, and that is what makes it safe rather than merely unlikely.
 * `esc()` has already turned every `<` in the text into `&lt;`, so a raw `<` cannot occur here except
 * in markup this function itself inserts — which means `<0>` cannot be forged by the input and cannot
 * appear by accident.
 *
 * The first version parked spans as a bare space-digit-space, and that DOES collide: text carrying its
 * own ` 0 ` had the digit in the prose replaced by the span. Measured, not imagined.
 */
function inline(safe: string): string {
  const spans: string[] = [];
  let out = safe.replace(/`([^`]+)`/g, (_m, code: string) => {
    spans.push(`<code>${code}</code>`);
    return `<${spans.length - 1}>`;
  });

  // Links: only http(s) and only as an href — a `javascript:` or `data:` URL in model prose is not a
  // link anyone asked for. The label keeps its own inline formatting by being processed already.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, href: string) => `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`);

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // `~~strike~~` is common enough in model prose to be worth one line.
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return out.replace(/<(\d+)>/g, (_m, i: string) => spans[Number(i)]);
}

/**
 * Markdown → HTML. The input is raw model output; the output is safe to insert.
 *
 * Block state is tracked explicitly rather than with a nested parser: a fence swallows everything until
 * it closes (including markdown, which is the point of a fence), and a list stays open across its
 * items. An unterminated fence at end of input is CLOSED rather than dropped — a model that got cut
 * off mid-block should still have its prose rendered, not swallowed by an open tag.
 */
export function renderWebMarkdown(raw: string): string {
  const lines = esc(raw).split('\n');
  const out: string[] = [];
  let inFence = false;
  let listKind: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const closeList = (): void => { if (listKind) { out.push(`</${listKind}>`); listKind = null; } };
  const flushPara = (): void => {
    if (!para.length) return;
    out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushPara(); closeList();
      out.push(inFence ? '</code></pre>' : '<pre><code>');
      inFence = !inFence;
      continue;
    }
    if (inFence) { out.push(line); continue; }

    if (!line.trim()) { flushPara(); closeList(); continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); closeList();
      // Capped at h4: these render inside a card, and an h1 from a model's prose would out-shout the
      // page's own headings.
      const level = Math.min(h[1].length + 2, 4);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }

    // `&gt;`, not `>`: escaping ran first, so the marker arrives already escaped. Every other block
    // marker (#, -, *, backtick, digits) is untouched by escaping, which is why this is the only rule
    // that has to know about it — and why it was the only one that silently stopped matching.
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      flushPara(); closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (listKind !== want) { closeList(); out.push(`<${want}>`); listKind = want; }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushPara(); closeList();
      out.push('<hr>');
      continue;
    }

    para.push(line.trim());
  }

  flushPara();
  closeList();
  if (inFence) out.push('</code></pre>');   // cut off mid-fence: close it rather than lose the prose
  return out.join('\n');
}
