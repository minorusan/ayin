/**
 * ui.ts — compatibility façade over the decoupled widget tree in src/ui/.
 *
 * Everything lives in src/ui/ now:
 *   headless.ts          HEADLESS/THINKING_MODE + noop factories
 *   theme.ts             every color/glyph in one place
 *   screen.ts            the one blessed screen (copy-paste contract: NO mouse tracking)
 *   layout.ts            the bottom-up widget stack — the only geometry authority
 *   keys.ts              the one keypress router
 *   widgets/chat.ts      ChatLog (+ tool-result diff cards)
 *   widgets/thinking.ts  ThinkingIndicator — stateful agent-status animation
 *   widgets/input.ts     InputBar (buffer, cursor, wrap, growth)
 *   widgets/hints.ts     CmdHints (+ slash-command registry)
 *   widgets/status.ts    StatusBar
 *
 * Import from './ui.js' keeps working for every existing caller.
 */

export * from './ui/index.js';
