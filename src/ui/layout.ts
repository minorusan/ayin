/**
 * Layout — the ONE place that knows how widgets stack.
 *
 * The screen is a vertical stack, bottom-up: status bar (1) → input (grows 3..10) →
 * command hints (0..6) → chat (everything else). Widgets used to reach into each other's
 * `bottom`/`height` to keep this true; now each bottom widget registers itself and calls
 * `relayout()` when its own height changes — nobody touches another widget's geometry.
 */

export interface StackedWidget {
  /** current height in rows (0 = hidden) */
  getHeight(): number;
  /** layout assigns the widget's bottom offset */
  setBottom(row: number): void;
}

let stack: StackedWidget[] = [];            // bottom-up order (status bar first)
let chat: { setBottom(row: number): void; redraw(): void } | null = null;

export function registerStack(widgets: StackedWidget[], chatWidget: { setBottom(row: number): void; redraw(): void }): void {
  stack = widgets;
  chat = chatWidget;
}

/** Restack everything from the bottom edge up; the chat gets whatever remains. */
export function relayout(): void {
  let bottom = 0;
  for (const w of stack) {
    w.setBottom(bottom);
    bottom += w.getHeight();
  }
  if (chat) {
    chat.setBottom(bottom);
    chat.redraw(); // chat pads content to its height → must redraw on any geometry change
  }
}
