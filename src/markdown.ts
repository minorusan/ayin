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
 */

import { theme } from './ui/theme.js';

export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
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
      // Escape blessed tags inside code — {open}/{close}, NOT backslashes (those render literally)
      const escaped = line.replace(/[{}]/g, m => (m === '{' ? '{open}' : '{close}'));
      result.push(`{${theme.mdCode}-fg}  │ ${escaped}{/}`);
      continue;
    }

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

function inlineFormat(line: string): string {
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
