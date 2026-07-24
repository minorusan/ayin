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

export interface Message {
  role: 'user' | 'assistant' | 'system';
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
  }

  add(role: Message['role'], content: string): void {
    if (HEADLESS) {
      if (role === 'assistant') process.stdout.write(content + '\n');
      else if (role === 'system') process.stderr.write(`[${role}] ${content}\n`);
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

    for (const msg of this.messages) {
      if (msg.role === 'user') {
        lines.push('');
        lines.push(`{bold}{${theme.accent}-fg} > ${msg.content}{/}`);
      } else if (msg.role === 'assistant') {
        lines.push('');
        for (const line of renderMarkdown(msg.content).split('\n')) {
          lines.push(`   ${line}`);
        }
      } else {
        lines.push(`{${theme.dim}-fg}   ${msg.content}{/}`);
      }
    }

    const indicatorLine = this.indicator.line();
    if (indicatorLine) {
      lines.push('');
      lines.push(` ${indicatorLine}`);
    }

    const padLines = Math.max(0, chatHeight - lines.length);
    this.box.setContent(Array(padLines).fill('').concat(lines).join('\n'));
    this.box.setScrollPerc(100);
    render();
  }

  destroy(): void {
    this.indicator.destroy();
  }
}

// ── tool-result decoration (write_file diff cards) ────────────────────

function escapeBlessedTags(text: string): string {
  return text.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

export function formatToolResultForChat(tool: string, content: string): string {
  if (tool !== 'write_file') return content;

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
  return rendered.join('\n');
}
