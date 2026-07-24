/**
 * ChatLog — the scrollable message area + the thinking indicator line.
 *
 * Owns the message list and how each role renders. Content is bottom-anchored (padded to
 * the box height) so the newest message sits just above the input, chat-app style.
 * No mouse tracking (see screen.ts copy-paste contract); scrolling is PgUp/PgDn.
 */

import blessed from 'blessed';
import { renderMarkdown } from '../../markdown.js';
import { HEADLESS, noopBox } from '../headless.js';
import { screen, render } from '../screen.js';
import { theme } from '../theme.js';
import { ThinkingIndicator, type AgentState } from './thinking.js';
import { getGoal, onGoalChange } from '../../goal.js';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
}

export class ChatLog {
  readonly box: blessed.Widgets.BoxElement;
  readonly indicator: ThinkingIndicator;
  private messages: Message[] = [];

  constructor() {
    this.box = HEADLESS
      ? noopBox
      : blessed.box({
        parent: screen,
        top: 0, left: 0, right: 0, bottom: 4,
        scrollable: true, alwaysScroll: true,
        scrollbar: { style: { bg: 'grey' } },
        // NO mouse:true — keeps terminal-native text selection/copy working.
        tags: true,
        padding: { left: 1, right: 1, top: 0, bottom: 0 },
        style: { fg: theme.text, bg: theme.bg },
      });
    this.indicator = new ThinkingIndicator(() => this.redraw());
    onGoalChange(() => this.redraw()); // goal line lives in this box; re-render when it changes
  }

  /** The goal line, shown in cursive+dim at the BOTTOM of the chat — just above the thinking
   *  indicator and the input, so it sits in the user's eyeline while they type/watch ayin think.
   *  Null when no goal is set. blessed can't do italic (its attr model has no italic bit — see
   *  docs), so "cursive" is a Unicode Mathematical-Italic transform of the letters; a genuine
   *  slant that needs no terminal italic support. Truncated by RAW length (pre-transform)
   *  because each italic glyph is a surrogate pair — String#length would over-count. */
  private goalLine(): string | null {
    const goal = getGoal();
    if (!goal) return null;
    const maxCols = Math.max(12, Number(screen.width ?? 80) - 3);
    let raw = `Goal: ${goal}`;
    if (raw.length > maxCols) raw = raw.slice(0, maxCols - 1) + '…';
    return ` {${theme.muted}-fg}${escapeBlessedTags(toItalic(raw))}{/}`;
  }

  add(role: MessageRole, content: string): void {
    if (HEADLESS) {
      if (role === 'assistant') process.stdout.write(content + '\n');
      else process.stderr.write(`[${role}] ${content}\n`);
      return;
    }
    this.messages.push({ role, content });
    this.redraw();
  }

  updateLastAssistant(content: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
        this.messages[i].content = content;
        this.redraw();
        return;
      }
    }
    this.add('assistant', content);
  }

  clear(): void {
    this.messages.length = 0;
    this.indicator.stop();
    this.redraw();
  }

  setAgentStatus(text: string): void {
    if (HEADLESS) return;
    this.indicator.setFromText(text);
  }

  setAgentState(state: AgentState, label?: string): void {
    if (HEADLESS) return;
    this.indicator.set(state, label);
  }

  setBottom(row: number): void {
    this.box.bottom = row;
  }

  scrollHalfPage(dir: 1 | -1): void {
    this.box.scroll(dir * Math.floor((this.box.height as number) / 2));
    render();
  }

  redraw(): void {
    if (HEADLESS) return;
    const chatHeight = Number(this.box.height ?? 20) - 1;
    const lines: string[] = [];

    // Every speaker gets a distinct left-edge anchor, so the eye can parse the transcript
    // by the gutter alone:
    //   ▌ bold        — the user (indigo bar)
    //   ◉ text        — ayin speaking (ayin = "eye"; accent glyph on the first line)
    //   ▸ │ ╰ cards   — tool calls (indented one step under the flow, amber frame)
    //   · dim         — system notices (quietest thing on screen)
    for (const msg of this.messages) {
      if (msg.role === 'user') {
        lines.push('');
        for (const line of msg.content.split('\n')) {
          lines.push(`{${theme.accent}-fg}▌{/} {bold}${escapeBlessedTags(line)}{/bold}`);
        }
      } else if (msg.role === 'assistant') {
        lines.push('');
        const rendered = renderMarkdown(msg.content).split('\n');
        rendered.forEach((line, i) => {
          lines.push(i === 0 ? `{${theme.accent}-fg}◉{/} ${line}` : `  ${line}`);
        });
      } else if (msg.role === 'tool') {
        for (const line of msg.content.split('\n')) {
          lines.push(`  ${line}`);
        }
      } else {
        msg.content.split('\n').forEach((line, i) => {
          lines.push(`  {${theme.dim}-fg}${i === 0 ? '· ' : '  '}${line}{/}`);
        });
      }
    }

    // The goal (cursive) and the thinking indicator live at the very BOTTOM of the chat, just
    // above the input — goal first, indicator under it — so both stay in the user's eyeline.
    const goalLine = this.goalLine();
    const indicatorLine = this.indicator.line();
    const tail: string[] = [];
    if (goalLine) tail.push(goalLine);
    if (indicatorLine) tail.push(` ${indicatorLine}`);
    if (tail.length) lines.push('', ...tail);

    const padLines = Math.max(0, chatHeight - lines.length);
    this.box.setContent([...Array(padLines).fill(''), ...lines].join('\n'));
    this.box.setScrollPerc(100);
    render();
  }

  destroy(): void {
    this.indicator.destroy();
  }
}

// ── tool-result decoration ────────────────────────────────────────────

function escapeBlessedTags(text: string): string {
  // blessed's escape syntax is {open}/{close} — NOT backslashes (those render literally).
  // Single pass so the '}' of an inserted '{open}' is never re-escaped.
  return text.replace(/[{}]/g, m => (m === '{' ? '{open}' : '{close}'));
}

/** Fake italic for a blessed TUI (which has no italic attribute — see docs): map ASCII letters
 *  to their Unicode Mathematical-Italic glyphs. Digits, spaces, and punctuation stay upright
 *  (Unicode has no italic digit block). Small 'h' is the one hole in the block — it lives at
 *  U+210E (ℎ, PLANCK CONSTANT) rather than the contiguous slot. Non-letters pass through, so
 *  the result is still safe to feed through escapeBlessedTags afterwards. */
export function toItalic(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (ch === 'h') out += String.fromCodePoint(0x210e);
    else if (c >= 0x61 && c <= 0x7a) out += String.fromCodePoint(0x1d44e + (c - 0x61)); // a–z
    else if (c >= 0x41 && c <= 0x5a) out += String.fromCodePoint(0x1d434 + (c - 0x41)); // A–Z
    else out += ch;
  }
  return out;
}

/** How many output lines each tool's chat card shows before truncating. */
const PREVIEW_LINES: Record<string, number> = { bash: 6, grep: 6, read_file: 4 };
const DEFAULT_PREVIEW_LINES = 2;

/** Styled tool-call header shown when a tool starts: `▸ bash · cat package.json` */
export function formatToolCallForChat(tool: string, params: string): string {
  const p = params ? ` {${theme.muted}-fg}· ${escapeBlessedTags(params)}{/}` : '';
  return `{${theme.tool}-fg}▸{/} {bold}{${theme.accent}-fg}${tool}{/${theme.accent}-fg}{/bold}${p}`;
}

function formatToolMs(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** Card footer: `╰ ✓ 0.4s` (green) or `╰ ✗ 12.0s` (red) when the result smells like an error. */
function toolFooter(content: string, elapsedMs?: number): string {
  if (elapsedMs === undefined) return '';
  const failed = /^error[:\s]/i.test(content.trim())
    || /^command exited with code/i.test(content.trim())
    || content.includes('(exit code ')
    || content.includes('(timeout after')
    || content.includes('(command failed');
  const mark = failed ? `{${theme.err}-fg}✗{/}` : `{${theme.ok}-fg}✓{/}`;
  return `\n{${theme.faint}-fg}╰{/} ${mark} {${theme.dim}-fg}${formatToolMs(elapsedMs)}{/}`;
}

/**
 * Render a tool result for the chat. write_file gets the diff card; every other tool gets a
 * gutter-block preview with blessed tags ESCAPED — raw output full of `{`/`}` (JSON, code)
 * used to be fed to blessed as markup, which silently ate or garbled it. When elapsedMs is
 * given, the card closes with a ✓/✗ + duration footer.
 */
export function formatToolResultForChat(tool: string, content: string, elapsedMs?: number): string {
  if (tool !== 'write_file') {
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) {
      return elapsedMs === undefined
        ? `{${theme.dim}-fg}(no output){/}`
        : `{${theme.faint}-fg}╰{/} {${theme.ok}-fg}✓{/} {${theme.dim}-fg}${formatToolMs(elapsedMs)} · no output{/}`;
    }
    const max = PREVIEW_LINES[tool] ?? DEFAULT_PREVIEW_LINES;
    const shown = lines.slice(0, max).map(l => {
      const cut = l.length > 200 ? l.slice(0, 200) + '…' : l;
      return `{${theme.faint}-fg}│{/} {${theme.diffCtx}-fg}${escapeBlessedTags(cut)}{/}`;
    });
    const more = lines.length > max
      ? `\n{${theme.faint}-fg}│{/} {${theme.dim}-fg}… ${lines.length - max} more lines — Ctrl+O to browse{/}`
      : '';
    return shown.join('\n') + more + toolFooter(content, elapsedMs);
  }

  const rendered: string[] = [];
  for (const line of content.split('\n')) {
    const escaped = escapeBlessedTags(line);
    if (line.startsWith('File: ')) {
      rendered.push(`{bold}{${theme.diffFileFg}-fg}{${theme.diffFileBg}-bg} ${escaped} {/${theme.diffFileBg}-bg}{/}`);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('@@')) {
      rendered.push(`{${theme.diffHunkFg}-fg}{${theme.diffHunkBg}-bg} ${escaped} {/${theme.diffHunkBg}-bg}{/}`);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      rendered.push(`{${theme.diffAddFg}-fg}{${theme.diffAddBg}-bg} ${escaped} {/${theme.diffAddBg}-bg}{/}`);
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      rendered.push(`{${theme.diffDelFg}-fg}{${theme.diffDelBg}-bg} ${escaped} {/${theme.diffDelBg}-bg}{/}`);
      continue;
    }
    if (line.startsWith(' ')) {
      rendered.push(`{${theme.diffCtx}-fg}${escaped}{/}`);
      continue;
    }
    rendered.push(escaped);
  }
  return rendered.join('\n') + toolFooter(content, elapsedMs);
}
