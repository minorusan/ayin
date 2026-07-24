/**
 * Headless detection + noop element factories.
 * Must be evaluated before any blessed initialization — every widget module imports from
 * here and builds real blessed elements only when a TUI is actually wanted.
 */

export const HEADLESS = process.argv.some(a => a === '-p' || a === '--prompt' || a === '--non-interactive')
  || process.argv[2] === 'watch'  // watch daemon has no TUI
  || process.argv[2] === 'rag';   // rag corpus generator has no TUI

export const THINKING_MODE = process.argv.includes('--thinking');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const noopScreen: any = {
  key: () => {}, on: () => {}, render: () => {}, destroy: () => {},
  removeListener: () => {}, append: () => {}, remove: () => {},
  width: 80, height: 24,
  program: { showCursor: () => {}, hideCursor: () => {}, cup: () => {} },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const noopBox: any = {
  height: 24, width: 80, bottom: 0,
  setContent: () => {}, setScrollPerc: () => {}, scroll: () => {},
  append: () => {}, remove: () => {}, destroy: () => {},
};
