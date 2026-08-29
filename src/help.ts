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
    name: '/indulge-model', kind: 'command', section: 'Code',
    short: 'What a CORPUS BUILD runs on — a separate choice from /model · /indulge-model openai gpt-4.1 · off',
    tip: 'A build is hours of tokens and the TIER is the whole cost. /indulge-model picks it without touching the agent.',
  },
  {
    name: '/diff', kind: 'command', section: 'Code',
    short: 'Working tree — staged, unstaged AND untracked — as a reviewable HTML page · /diff <rev> to compare against one',
    tip: '/diff opens your working tree as a real review page — filters, per-file triage, changed tokens marked.',
  },
  {
    name: '/chore', kind: 'command', section: 'Code',
    short: 'Members added in the last commits that nothing uses — with the commit that added each · also opens a page',
    tip: '/chore finds code you added this week and nobody calls, naming the commit it came in on.',
  },
  {
    name: '/unity-test', kind: 'command', section: 'Code',
    short: 'Run Unity tests for assemblies you name (comma-separated) · bare /unity-test lists them and which are PlayMode',
  },
  {
    name: '/prefab', kind: 'command', section: 'Code',
    short: 'A Unity .prefab, scene or .asset as a hierarchy — components, and every guid resolved to the asset it points at',
    tip: '/prefab <file> shows a Unity asset as a tree with its references named, not as 16,000 lines of YAML.',
  },
  {
    name: '/explain', kind: 'command', section: 'Code',
    short: 'Explain a feature or answer a question about this codebase, in prose, from the code it read',
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
    short: 'Build the per-repo corpus overnight — see docs/INDULGE.md. --domains "<what you work on>" · --jira PROJ-42 for an epic',
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
  { name: '/reset', kind: 'command', section: 'Session', short: "Restore ayin's prompts to the shipped text — your edited copies are kept as .bak-… · does NOT clear the chat" },
  {
    name: '/transcribe', kind: 'command', section: 'Session',
    short: 'Record EVERYTHING — prompts, raw responses, full tool results — to a JSON file. Big on purpose · /transcribe off',
    tip: '/transcribe logs every prompt and raw response to JSON — turn it on BEFORE the weird bug.',
  },
  { name: '/wipe', kind: 'command', section: 'Session', short: 'Delete saved state — sessions · /wipe all · artifacts · logs · transcripts. Asks first' },
  { name: '/git-hardreset', kind: 'command', section: 'Session', short: 'Undo a turn: reset tracked files to HEAD and DELETE untracked ones — stashed first, so `git stash pop` brings it all back' },
  { name: '/git-softreset', kind: 'command', section: 'Session', short: 'Undo the LAST COMMIT and keep its changes staged (git reset --soft HEAD~1) — warns if it is already pushed' },
  { name: '/quit', kind: 'command', section: 'Session', short: 'Exit (/q, /exit)' },
  { name: '/help', kind: 'command', section: 'Session', short: 'This list' },

  // ── the model ──────────────────────────────────────────────────────────────────
  { name: '/model', kind: 'command', section: 'Model', short: 'Who answers — local or OpenAI (popup) · /model gemma|qwen|glm|auto forces the tool-call dialect · /model <name|qwen|gemma> to switch straight away' },
  { name: '/set', kind: 'command', section: 'Model', short: '/set <key> <value> — persist a setting (kebab-case: /set terminal-command …)' },

  // ── connectors ─────────────────────────────────────────────────────────────────
  { name: '/jira-auth', kind: 'command', section: 'Connectors', short: 'Store a Jira token + site (verified before saving); bare /jira-auth shows status' },
  { name: '/jira', kind: 'command', section: 'Connectors', short: 'Ask Jira directly — an agentic loop against its API' },
  {
    name: '/sprint', kind: 'command', section: 'Connectors',
    short: 'Your sprint as a board in the browser — click a ticket for its text, + posts a comment to Jira',
    tip: '/sprint opens your sprint as a kanban board; clicking a ticket shows it, and + comments on it.',
  },
  { name: '/sentry-auth', kind: 'command', section: 'Connectors', short: 'Store a Sentry token + org slug' },
  { name: '/sentry', kind: 'command', section: 'Connectors', short: 'Ask Sentry directly' },
  { name: '/slack-auth', kind: 'command', section: 'Connectors', short: 'Store a Slack user token (xoxp-); a bot token is refused' },
  { name: '/slack', kind: 'command', section: 'Connectors', short: 'Search and read your Slack directly' },
  { name: '/openai', kind: 'command', section: 'Connectors', short: 'Store and verify an OpenAI key · switching to it is /model openai — two decisions, two commands' },

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
  {
    name: 'ayin diff', kind: 'cli', section: 'From your shell',
    short: 'Serve the /diff review page without a TUI and stay up · ayin diff <rev> · --no-open · --static',
    tip: '`ayin diff` from any shell serves the review page — comment on a line and a headless run answers it.',
  },
  {
    name: 'ayin sprint', kind: 'cli', section: 'From your shell',
    short: 'Serve the /sprint board without a TUI and stay up · --no-open',
  },
  {
    name: 'ayin launch', kind: 'cli', section: 'From your shell',
    short: 'Open a terminal window at the front Finder/Explorer directory, running ayin. For a hotkey — see docs/LAUNCH.md',
  },
  { name: 'ayin testrun', kind: 'cli', section: 'From your shell', short: 'ayin testrun "<domain>" · --list shows what would run without running it' },
  {
    name: 'ayin chore', kind: 'cli', section: 'From your shell',
    short: 'ayin chore [--commits N] [--all] [--html] — recently added members nothing uses, as text',
  },
  {
    name: 'ayin unity', kind: 'cli', section: 'From your shell',
    short: 'The Unity toolkit: unity prefab <file> · unity animator <file> · unity prefab_edit … · unity test <Asm,Asm> · unity test --assemblies',
    tip: 'ayin unity test --assemblies lists what can be run and which are PlayMode — then ayin unity test Asm1,Asm2.',
  },
  { name: 'ayin explain', kind: 'cli', section: 'From your shell', short: 'ayin explain "<question>" — prints the narrative and exits' },
  { name: 'ayin watch', kind: 'cli', section: 'From your shell', short: 'Repo watcher daemon — reviews what lands, resumes itself after a reboot' },
  { name: 'ayin unwatch', kind: 'cli', section: 'From your shell', short: 'Stop watching this repo: remove the hooks it installed and deregister it (--all, --stop)' },
  { name: 'ayin -p', kind: 'cli', section: 'From your shell', short: 'Headless: ayin -p "<task>". Auto-approves writes and shell — run it on a tree you can revert' },
  { name: 'ayin debug', kind: 'cli', section: 'From your shell', short: 'ayin debug [dir] — the same bundle without the TUI, for a run nobody was sitting in front of' },
  { name: 'ayin --debug', kind: 'cli', section: 'From your shell', short: 'Start the TUI with /debug already applied — the bundle path exists before anything goes wrong' },
  { name: 'ayin --full', kind: 'cli', section: 'From your shell', short: 'Everything on for this launch: debug bundle, QA session, permission gate skipped — push/pull still refuse' },
  {
    name: 'ayin --postmortem', kind: 'cli', section: 'From your shell',
    short: 'Headless: if the run dies without finishing — killed, crashed, cancelled by a parent — write a note saying where it got to, in the working dir AND ~/.ayin-cli/postmortems/',
    tip: '`--postmortem` on headless: a killed run leaves a note saying what tool it died inside and how far it got.',
  },
  {
    name: 'ayin --arbiter', kind: 'cli', section: 'From your shell',
    short: 'The top level decides and delegates: bash, grep and the edit primitives are withheld from it, and it works through perform_edit, find_relevant_files and subagent instead',
    tip: '`--arbiter` takes the edit primitives off the top level so it delegates instead of typing.',
  },
  { name: 'ayin --disallow-subagents', kind: 'cli', section: 'From your shell', short: 'No delegation this session: the `subagent` tool is withheld, so the agent works every phase itself' },
  { name: 'ayin --allow-parallel-subagents', kind: 'cli', section: 'From your shell', short: 'Let several subagents run at once. OFF by default — two agents editing one tree lose each other\'s writes' },
  { name: 'ayin kill dog', kind: 'cli', section: 'From your shell', short: 'Disable every hound Stop hook instantly and persistently — `--off` brings it back' },
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
 * Edit distance, for "did you mean". Its own copy on purpose.
 *
 * `tools/lib.ts` has one, and importing it here would drag the tool registry into a module that must load
 * before anything is wired — the initialization-order bug `check:gates` exists to prevent. An algorithm
 * duplicated is not a FACT duplicated: this one cannot drift from the other in a way anybody notices.
 */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * The names closest to what was typed — the help list IS the database, so a command that exists is
 * suggestible and one that does not cannot be.
 *
 * A mistyped command must never run something else, and it must never be silently ignored either: the CLI
 * used to discard a bare word it did not recognise and launch the TUI, so `ayin unty prefab` opened a
 * session and threw the rest away. Exact match first (a name typed correctly is not a suggestion), then a
 * distance that scales with the word — one edit for a short name, three for a long one, because a
 * suggestion list that includes everything is noise.
 */
export function suggestNames(typed: string, kind: HelpEntry['kind']): string[] {
  const bare = (name: string): string => name.replace(/^ayin\s+/, '').replace(/^\//, '');
  const wanted = bare(typed).toLowerCase();
  if (!wanted) return [];
  const pool = HELP.filter((e) => e.kind === kind).map((e) => bare(e.name)).filter((n) => n && !n.startsWith('-'));

  const exact = pool.filter((n) => n.toLowerCase() === wanted);
  if (exact.length) return exact;

  const budget = Math.max(1, Math.min(3, Math.floor(wanted.length / 3)));
  const scored = pool
    .map((n) => ({ n, d: distance(n.toLowerCase(), wanted) }))
    // A prefix is a near-miss however far the tail is: someone typing `pref` means `prefab`.
    .filter((x) => x.d <= budget || x.n.toLowerCase().startsWith(wanted) || wanted.startsWith(x.n.toLowerCase()))
    .sort((a, b) => a.d - b.d);
  return [...new Set(scored.map((x) => x.n))].slice(0, 4);
}

/** Every command of a kind, for the "here is what exists" half of a refusal. */
export function namesOfKind(kind: HelpEntry['kind']): string[] {
  return HELP.filter((e) => e.kind === kind)
    .map((e) => e.name.replace(/^ayin\s+/, '').replace(/^\//, ''))
    .filter((n) => n && !n.startsWith('-'))
    .sort();
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
