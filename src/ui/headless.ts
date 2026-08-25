/**
 * Headless detection + noop element factories.
 * Must be evaluated before any blessed initialization — every widget module imports from
 * here and builds real blessed elements only when a TUI is actually wanted.
 */

/** Subcommands that are plain stdout commands, not the TUI — blessed must never grab the
 *  terminal for these (it would swallow their output and leave the tty in a raw state). */
const NO_TUI_COMMANDS = new Set([
  'watch',      // watch daemon
  'sentinaile-supervisor', // detached scheduler; owns no terminal
  'update',     // self-update from the registry
  'version', '--version', '-v',
  'explain',    // headless `ayin explain "<question>"` — prints the narrative, exits
  'indulge',    // overnight corpus build — runs for hours under nohup; must never open a TUI
  'launch',     // opens a terminal window elsewhere and exits; taking this tty would be the wrong one
  'diff',       // serves the review page and parks on it; prints a URL, never paints a screen
  'sprint',     // serves the Jira board and parks on it, exactly like `diff`
  'debug',      // writes a bundle and prints its path
  'testrun',    // runs C# tests and prints a report
  'kill',       // `ayin kill dog` — throws the hound kill switch and prints what it touched
  'unwatch',    // removes hooks from a repo and prints what it touched — it was MISSING, so taking
                // back a watcher opened a full-screen TUI for the duration of a few file writes
  'chore',      // `ayin chore` — prints a dead-code report and exits
  'unity',      // `ayin unity prefab|animator|prefab_edit|test` — prints and exits, like testrun. Absent
                // from this list it printed its answer and THEN opened an alternate screen to tear it
                // down again, which clears the terminal the answer was just written to.
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
