/**
 * Markdown → blessed tags converter.
 *
 * Converts common markdown to blessed's tag format:
 *   **bold**     → {bold}bold{/bold}
 *   *italic*     → {underline}italic{/underline}  (terminals fake italic with underline)
 *   `code`       → {#61AFEF-fg}code{/}
 *   ```blocks``` → indented, colored
 *   # headings   → bold + colored
 *   - lists      → preserved with indent
 *
 * All colors come from the active theme (src/ui/theme.ts) — nothing hardcoded here.
 *
 * Two entry points: `renderMarkdown` for the main chat transcript (one logical line in → one styled
 * line out, no rewrapping — the chat box's own scroll handles overflow). `renderMarkdownWrapped` for
 * FIXED-WIDTH contexts (the permission dialog's `body`, a QA card's body lines) that must word-wrap —
 * a model's own prose routinely carries full markdown (headings, bold, bullets), and before this
 * existed those contexts only ever showed it raw (literal `**`/`###`/`*`), because wrapping already-
 * tagged text risks splitting a `{tag}` across the wrap boundary and corrupting the whole render.
 */

import { theme } from './ui/theme.js';

/** blessed's escape syntax is {open}/{close} — NOT backslashes (those render literally). Applied to
 *  every ordinary prose line before any markdown-generated tag is added, so a `{`/`}` the MODEL wrote
 *  (JSON in an unfenced example, a stray brace) can never be mistaken for one of ours. */
function escapeTags(text: string): string {
  return text.replace(/[{}]/g, (m) => (m === '{' ? '{open}' : '{close}'));
}

export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (const rawLine of lines) {
    // Code block toggle
    if (rawLine.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = rawLine.trimStart().slice(3).trim();
        result.push(`{${theme.mdCodeFrame}-fg}  ┌─${codeBlockLang ? ' ' + codeBlockLang + ' ' : ''}──{/}`);
        continue;
      } else {
        inCodeBlock = false;
        result.push(`{${theme.mdCodeFrame}-fg}  └────{/}`);
        continue;
      }
    }

    // Inside code block — no markdown processing, just color
    if (inCodeBlock) {
      result.push(`{${theme.mdCode}-fg}  │ ${escapeTags(rawLine)}{/}`);
      continue;
    }

    // Every OTHER branch below inserts its own legitimate tags, so raw `{`/`}` in the model's own
    // text is escaped once, up front — never after, which would mangle tags this function just added.
    const line = escapeTags(rawLine);

    // Headings
    const h1 = line.match(/^#\s+(.+)/);
    if (h1) {
      result.push(`{bold}{${theme.mdH1}-fg}${h1[1]}{/}`);
      continue;
    }
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      result.push(`{bold}{${theme.mdH2}-fg}${h2[1]}{/}`);
      continue;
    }
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) {
      result.push(`{bold}{${theme.mdH3}-fg}${h3[1]}{/}`);
      continue;
    }

    // Horizontal rules
    if (/^---+$/.test(line.trim())) {
      result.push(`{${theme.mdRule}-fg}────────────────────────────────{/}`);
      continue;
    }

    // Apply inline formatting
    result.push(inlineFormat(line));
  }

  // Close unclosed code block
  if (inCodeBlock) {
    result.push(`{${theme.mdCodeFrame}-fg}  └────{/}`);
  }

  return result.join('\n');
}

/** Inline-only formatting (bold/italic/inline-code/bullet-prefix) — no heading/code-block handling,
 *  no `{}`-escaping (the caller is expected to have already escaped raw text — see `escapeTags`).
 *  Exported so other fixed-line contexts (a QA card's body lines, already one-per-line) can apply the
 *  same styling without going through the line-splitting/code-block machinery above. */
export function inlineFormat(line: string): string {
  let out = line;

  // Inline code: `code` → colored (must be done before bold/italic to avoid conflicts)
  out = out.replace(/`([^`]+)`/g, `{${theme.mdInlineCode}-fg}$1{/}`);

  // Bold: **text** → {bold}text{/bold}
  out = out.replace(/\*\*(.+?)\*\*/g, '{bold}$1{/bold}');

  // Italic: *text* → {underline}text{/underline} (but not inside already-processed bold)
  out = out.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '{underline}$1{/underline}');

  // List items: - or * at start
  out = out.replace(/^(\s*)[*-]\s/, '$1• ');

  // Numbered lists: preserve as-is

  return out;
}

/**
 * Markdown, word-wrapped to a fixed `width` — for the permission dialog's `body` and similar
 * fixed-column contexts. `wrapPlain` (word-wrapping) runs BEFORE any blessed tag is added — wrapping
 * already-tagged text risks splitting a `{tag}` mid-sequence, corrupting the entire render (this is
 * `wrapPlain`'s own documented reason for existing). So the pipeline is: strip line-START markers
 * (`#`/`##`/`###` heading, `-`/`*` bullet — safe, since they only ever affect where a paragraph
 * begins, never mid-line wrapping) → wrap the still-plain paragraph text (inline markers like `**`/
 * `` ` `` are ordinary characters to the wrapper, so they travel with their surrounding words intact
 * in the overwhelmingly common case of a span shorter than one wrapped line) → apply `inlineFormat`
 * to each ALREADY-WRAPPED line independently, then bold the whole paragraph if it was a heading.
 *
 * KNOWN, ACCEPTED DEGRADATION: a bold/code span itself longer than one wrapped line loses its styling
 * on the line where it's split (the closing marker isn't there yet) rather than corrupting the tag
 * stream — the right failure mode for a side dialog, not the main chat transcript.
 */
export function renderMarkdownWrapped(text: string, width: number, wrap: (s: string, w: number) => string[]): string[] {
  const headingParagraphs = new Set<number>();
  const prepared: string[] = [];

  for (const rawLine of text.split('\n')) {
    const line = escapeTags(rawLine);
    const heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading) {
      headingParagraphs.add(prepared.length);
      prepared.push(heading[2]);
      continue;
    }
    const bullet = line.match(/^(\s*)[*-]\s+(.+)/);
    if (bullet) {
      prepared.push(`${bullet[1]}• ${bullet[2]}`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      prepared.push('────────');
      continue;
    }
    prepared.push(line);
  }

  const out: string[] = [];
  prepared.forEach((para, i) => {
    const wrapped = wrap(para, width).map(inlineFormat);
    if (headingParagraphs.has(i)) out.push(...wrapped.map((l) => `{bold}${l}{/bold}`));
    else out.push(...wrapped);
  });
  return out;
}
