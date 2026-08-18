/**
 * help.ts — every command and trick ayin has, in ONE place.
 *
 * This file exists because there were already three: the `case '/…'` labels in `app.ts` that decide
 * what actually runs, the `COMMANDS` array in `ui/widgets/hints.ts` that decides what the typing
 * hint panel offers, and a hand-written run of `addMessage` calls in `/help`. Nothing kept them in
 * step, so `/diff` shipped with no hint entry and `!` — arguably the single most-used feature — was
 * in none of them. A command the operator cannot discover may as well not have been built.
 *
 * Three consumers, one list:
 *   - `/help`             — everything, grouped.
 *   - the hint panel      — the `/…` entries, matched by prefix while typing.
 *   - the goal line       — one random `tip` on launch, in the space a goal will later occupy.
 *
 * The tip is chosen ONCE per process, at module load. A tip that re-rolled on every render would
 * change while being read, which is worse than showing nothing.
 */

export type HelpKind = 'command' | 'trick' | 'key' | 'cli';

export interface HelpEntry {
  /** `/diff`, `!<command>`, `Ctrl+O`, `ayin indulge` — whatever the operator would type or press. */
  name: string;
  kind: HelpKind;
  section: string;
  /** One line. This is what the hint panel shows, so it has to stand alone. */
  short: string;
  /**
   * The same thing said as a discovery, for the goal line. Present only where finding out is
   * genuinely worth an operator's attention — a tip for `/quit` would train them to ignore tips.
   */
  tip?: string;
}

export const HELP: HelpEntry[] = [
  // ── the tricks nobody discovers by typing a slash ──────────────────────────────
  {
    name: '!<command>', kind: 'trick', section: 'Tricks',
    short: 'Runs the rest of the line in your shell VERBATIM, in bold. The model never sees it. Esc cancels.',
    tip: 'Start a line with ! and the whole thing goes straight to your shell — no model, no tokens.',
  },
  {
    name: 'double-Shift', kind: 'trick', section: 'Tricks',
    short: 'Bind it to `ayin launch` and it opens ayin at the folder Finder/Explorer is showing. See docs/LAUNCH.md.',
    tip: 'Bind double-Shift to `ayin launch` — it opens ayin wherever your file manager is pointed.',
  },
  {
    name: 'first prompt', kind: 'trick', section: 'Tricks',
    short: 'The first prompt of a session is looked up in the corpus automatically — it states the task, so it is the one query worth embedding.',
    tip: 'Your first prompt of a session is searched against the corpus automatically. Make it the real question.',
  },
  {
    name: 'reading a file', kind: 'trick', section: 'Tricks',
    short: 'Every read_file also shows what indulge already answered about that file, and what the attributors know about it.',
    tip: 'When ayin reads a file it also gets what indulge learned about it — build a corpus and it stops guessing.',
  },

  // ── working on code ────────────────────────────────────────────────────────────
  {
    name: '/diff', kind: 'command', section: 'Code',
    short: 'Working tree — staged, unstaged AND untracked — as a reviewable HTML page · /diff <rev> to compare against one',
    tip: '/diff opens your working tree as a real review page — filters, per-file triage, changed tokens marked.',
  },
  {
    name: '/explain', kind: 'command', section: 'Code',
    short: 'Explain a feature or answer a question about this codebase, with a diagram where it helps',
    tip: '/explain <feature> walks the codebase and comes back with a narrative, not a file list.',
  },
  {
    name: '/plan', kind: 'command', section: 'Code',
    short: 'Plan mode for the session: survey → API research → explore → a written ayin-plan-*.md, then execute · /planthis <text> for one prompt',
    tip: '/plan makes ayin write the plan to a file before touching anything — and then follow it.',
  },
  {
    name: '/qa', kind: 'command', section: 'Code',
    short: 'QA gate for the session — compilation and artifacts checked against what you asked for · /qathis <msg> for one reply',
    tip: '/qa turns on a gate that checks the build and the artifacts against your actual request before answering.',
  },
  {
    name: '/present', kind: 'command', section: 'Code',
    short: 'Presenter pass — a composed answer, with a diagram when it earns one · /presentthis <msg> for one reply',
  },
  {
    name: '/testrun', kind: 'command', section: 'Code',
    short: 'Run the C# tests covering a domain — /testrun reward service · selection comes from the corpus',
    tip: '/testrun <domain> runs only the tests covering it — the corpus decides which, not a guess.',
  },
  {
    name: '/sentinaile', kind: 'command', section: 'Code',
    short: 'A standing watch — /sentinaile check CI every 10 minutes · /sentinaile stop · bare for status',
    tip: 'Plans once into sentinaile_plan.md; edit it to change what each run does.',
  },
  {
    name: '/skip-permissions', kind: 'command', section: 'Code',
    short: 'Run tool calls without confirmation for THIS session — /skip-permissions off to restore',
    tip: 'git push/pull/checkout stay gated, and with prompts off they are denied rather than allowed.',
  },
  { name: '/disentangle', kind: 'command', section: 'Code', short: 'Drop the entangle constraint for this session' },
  { name: '/arduino-explain', kind: 'command', section: 'Code', short: 'Explain an Arduino sketch and regenerate its diagram' },

  // ── the corpus ─────────────────────────────────────────────────────────────────
  {
    name: '/embed', kind: 'command', section: 'Corpus',
    short: "Look this session's prompts up in the corpus (the first one is automatic) · /embed off",
    tip: '/embed searches the corpus for every prompt this session, not just the first.',
  },
  { name: '/embedthis', kind: 'command', section: 'Corpus', short: 'Corpus lookup for ONE prompt only — /embedthis <question>' },
  {
    name: '/corpus', kind: 'command', section: 'Corpus',
    short: 'Show what indulge already answered about a file when it is read (default ON) · /corpus off',
    tip: 'Wondering whether retrieval is helping? /corpus off, run the same task, compare. That is the only honest test.',
  },
  {
    name: 'ayin indulge', kind: 'cli', section: 'Corpus',
    short: 'Build the per-repo corpus overnight — see docs/INDULGE.md. --domains "<what you work on>" --depth 2',
    tip: 'Leave `ayin indulge --domains "<your feature>"` running overnight and ayin wakes up knowing your repo.',
  },

  // ── modes ──────────────────────────────────────────────────────────────────────
  {
    name: '/verbose', kind: 'command', section: 'Modes',
    short: 'Full explanations. Without it, answers are as short as the question allows · /verbose off',
    tip: 'Answers are terse by default. /verbose when you want the reasoning, not the result.',
  },
  {
    name: '/logcover', kind: 'command', section: 'Modes',
    short: 'Heavy log coverage on every feature built while it is on · /logcover off',
    tip: '/logcover makes ayin instrument everything it builds while it is on — useful right before a hard debug.',
  },
  { name: '/goal', kind: 'command', section: 'Modes', short: 'Set the session goal, shown above the chat and carried into every turn · /goal clear' },

  // ── session ────────────────────────────────────────────────────────────────────
  {
    name: '/resume', kind: 'command', section: 'Session',
    short: "This directory's past sessions, newest first · /resume <n>|<id> restores one · /resume all for every directory",
    tip: '/resume brings back a past session in this directory — new turns append to its record.',
  },
  {
    name: '/debug', kind: 'command', section: 'Session',
    short: '/debug [dir] — dump session, log, timings and REDACTED config somewhere another machine can read',
    tip: '/debug <dir> writes everything needed to diagnose a session, with secrets stripped — hand it to someone.',
  },
  { name: '/summary', kind: 'command', section: 'Session', short: 'Session summary (Esc closes) — same as Ctrl+S' },
  { name: '/clear', kind: 'command', section: 'Session', short: 'Clear the chat view (the session itself is untouched)' },
  { name: '/reset', kind: 'command', section: 'Session', short: 'Start over — new session, empty context' },
  {
    name: '/transcribe', kind: 'command', section: 'Session',
    short: 'Record EVERYTHING — prompts, raw responses, full tool results — to a JSON file. Big on purpose · /transcribe off',
    tip: '/transcribe logs every prompt and raw response to JSON — turn it on BEFORE the weird bug.',
  },
  { name: '/wipe', kind: 'command', section: 'Session', short: 'Delete saved state — sessions · /wipe all · artifacts · logs · transcripts. Asks first' },
  { name: '/quit', kind: 'command', section: 'Session', short: 'Exit (/q, /exit)' },
  { name: '/help', kind: 'command', section: 'Session', short: 'This list' },

  // ── the model ──────────────────────────────────────────────────────────────────
  { name: '/model', kind: 'command', section: 'Model', short: 'Pick from the models the backend serves (popup) · /model <name|qwen|gemma> to switch straight away' },
  {
    name: '/lock', kind: 'command', section: 'Model',
    short: 'Hold the model for this session — ⚿ in the bar; self-releases 10 min after you stop · /unlock',
    tip: '/lock holds the model for your session and frees it by itself if this client dies.',
  },
  { name: '/set', kind: 'command', section: 'Model', short: '/set <key> <value> — persist a setting (kebab-case: /set terminal-command …)' },

  // ── connectors ─────────────────────────────────────────────────────────────────
  { name: '/jira-auth', kind: 'command', section: 'Connectors', short: 'Store a Jira token + site (verified before saving); bare /jira-auth shows status' },
  { name: '/jira', kind: 'command', section: 'Connectors', short: 'Ask Jira directly — an agentic loop against its API' },
  { name: '/sentry-auth', kind: 'command', section: 'Connectors', short: 'Store a Sentry token + org slug' },
  { name: '/sentry', kind: 'command', section: 'Connectors', short: 'Ask Sentry directly' },
  { name: '/openai', kind: 'command', section: 'Connectors', short: 'Use OpenAI instead of the local model · /openai key sk-…' },

  // ── keys ───────────────────────────────────────────────────────────────────────
  {
    name: 'Ctrl+O', kind: 'key', section: 'Keys',
    short: 'Browse full tool output — every tool run is saved; ←/→ to page through them',
    tip: 'Ctrl+O opens the FULL output of every tool call, not the summary in the chat. ←/→ to page.',
  },
  { name: 'Ctrl+S', kind: 'key', section: 'Keys', short: 'Session summary' },
  { name: 'Esc', kind: 'key', section: 'Keys', short: 'Close an overlay · cancel a running ! command · interrupt the agent' },
  {
    name: 'Esc Esc', kind: 'key', section: 'Keys',
    short: 'Clear what you have typed — only when Escape had nothing else to do',
    tip: 'Esc Esc clears the prompt. One press never does, so a stray Escape cannot eat what you typed.',
  },
  { name: 'Alt+Enter', kind: 'key', section: 'Keys', short: 'Newline without submitting (also Ctrl+J) — a paste keeps its own newlines' },
  { name: 'Ctrl+C', kind: 'key', section: 'Keys', short: 'Quit' },
  { name: 'PgUp / PgDn', kind: 'key', section: 'Keys', short: 'Scroll an open overlay' },

  // ── from the shell ─────────────────────────────────────────────────────────────
  { name: 'ayin diff', kind: 'cli', section: 'From your shell', short: 'The /diff page without starting the TUI · ayin diff <rev> · --no-open' },
  {
    name: 'ayin launch', kind: 'cli', section: 'From your shell',
    short: 'Open a terminal window at the front Finder/Explorer directory, running ayin. For a hotkey — see docs/LAUNCH.md',
  },
  { name: 'ayin testrun', kind: 'cli', section: 'From your shell', short: 'ayin testrun "<domain>" · --list shows what would run without running it' },
  { name: 'ayin explain', kind: 'cli', section: 'From your shell', short: 'ayin explain "<question>" — prints the narrative and exits' },
  { name: 'ayin watch', kind: 'cli', section: 'From your shell', short: 'Repo watcher daemon — reviews what lands, resumes itself after a reboot' },
  { name: 'ayin -p', kind: 'cli', section: 'From your shell', short: 'Headless: ayin -p "<task>". Auto-approves writes and shell — run it on a tree you can revert' },
  { name: 'ayin debug', kind: 'cli', section: 'From your shell', short: 'ayin debug [dir] — the same bundle without the TUI, for a run nobody was sitting in front of' },
  { name: 'ayin update', kind: 'cli', section: 'From your shell', short: 'Self-update from the configured registry' },
];

/** Section order for `/help`. Tricks first: they are what nobody finds by typing a slash. */
export const SECTIONS = [
  'Tricks', 'Code', 'Corpus', 'Modes', 'Session', 'Model', 'Connectors', 'Keys', 'From your shell',
];

/** The `/…` entries, for the typing hint panel. */
export function slashEntries(): HelpEntry[] {
  return HELP.filter((e) => e.name.startsWith('/'));
}

export function entriesInSection(section: string): HelpEntry[] {
  return HELP.filter((e) => e.section === section);
}

/**
 * One tip, fixed for the life of this process.
 *
 * Not re-rolled per render: the goal line repaints on every screen update, and a tip that changed
 * mid-sentence would be unreadable. Not persisted either — the point is that a new launch shows
 * something new.
 */
const TIPS = HELP.filter((e) => e.tip).map((e) => e.tip as string);
const CHOSEN = TIPS.length ? TIPS[Math.floor(Math.random() * TIPS.length)] : null;

export function launchTip(): string | null {
  return CHOSEN;
}
