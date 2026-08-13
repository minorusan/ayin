/**
 * Headless detection + noop element factories.
 * Must be evaluated before any blessed initialization — every widget module imports from
 * here and builds real blessed elements only when a TUI is actually wanted.
 */

/** Subcommands that are plain stdout commands, not the TUI — blessed must never grab the
 *  terminal for these (it would swallow their output and leave the tty in a raw state). */
const NO_TUI_COMMANDS = new Set([
  'watch',      // watch daemon
  'update',     // self-update from the registry
  'version', '--version', '-v',
  'explain',    // headless `ayin explain "<question>"` — prints the narrative, exits
]);

export const HEADLESS = process.argv.some(a => a === '-p' || a === '--prompt' || a === '--non-interactive')
  || NO_TUI_COMMANDS.has(process.argv[2]);

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
