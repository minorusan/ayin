/**
 * bang-check.ts — the spell-check in front of `!<command>`, and the only thing allowed to touch it.
 *
 * `bang.ts` still runs what it is handed VERBATIM — that invariant is untouched and `check-bang.mjs`
 * still asserts it. The correction happens here, before the shell is spawned, so there is exactly one
 * place where a typed line can change and it is a place with a validator in it.
 *
 * WHAT IT IS FOR. `!gti staus -sb` costs a round trip through the operator's own eyes: the shell says
 * "command not found", they retype it. One tiny model call fixes the spelling and runs the command
 * they meant. It corrects; it does not interpret — the whole point of `!` is that the agent is not
 * deciding what the operator wanted.
 *
 * WHY THE MODEL'S ANSWER IS NOT TRUSTED. "Maybe improved" is where this becomes dangerous: a model
 * asked to fix a line can helpfully add `-f`, a redirection, an `rm`, a `git push`. So the reply is
 * vetted by `vetRewrite`, which is MODEL-FREE and rejects any rewrite that escalates — a new
 * destructive token, a new always-gated git op, or an answer three times the length of the question.
 * A rejected rewrite is not an error: the line the operator typed runs, exactly as before.
 *
 * WHY IT CANNOT COST THE OPERATOR ANYTHING. The call races a timeout (`bangCheckMs`, default 3s,
 * 0 disables the feature). Timeout, a dead endpoint, a busy card, a malformed reply — every one of
 * them falls through to running what was typed. A passthrough that a model outage can block is worse
 * than no spell-check, so this never blocks and never throws.
 */

import { dangerousShellOp } from './permissions.js';

/** Default ceiling on the check. Past this the typed line runs — see `bangCheckMs` in prompts.ts. */
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * A correction is a correction, not a rewrite. `gti staus` → `git status` grows a little; a reply
 * three times the line plus a bit is the model writing its own command, and that is not the deal.
 */
const MAX_GROWTH_FACTOR = 3;
const MAX_GROWTH_CHARS = 40;

/**
 * Tokens a fix may PRESERVE but never INTRODUCE. Every one of them turns "you misspelled it" into a
 * different command with a bigger blast radius, and the operator approved neither.
 */
const ESCALATIONS: readonly RegExp[] = [
  /(^|\s)rm(\s|$)/, /(^|\s)sudo(\s|$)/, /(^|\s)dd(\s|$)/, /(^|\s)mkfs/, /(^|\s)shutdown(\s|$)/,
  /(^|\s)reboot(\s|$)/, /(^|\s)kill(all)?(\s|$)/, /(^|\s)truncate(\s|$)/, /--hard(\s|$)/,
  /--force(\s|$)/, /(^|\s)-f(\s|$)/, />/,
];

/** The contents of every closed `'…'` / `"…"` pair, in order. */
function quoted(line: string): string[] {
  return [...line.matchAll(/(['"])(.*?)\1/g)].map((m) => m[2]);
}

export interface BangCheckResult {
  /** What to run. The typed line unless a rewrite survived the vet. */
  command: string;
  /** One line for the operator, or null when nothing happened worth saying. */
  note: string | null;
}

/** Announced once per session, not once per command — a dead endpoint must not become a wall of noise. */
let failureAnnounced = false;

/**
 * The model's raw reply → the command to run, or null for "run what was typed".
 *
 * Exported because this is the half that must be tested without a model, and it is the half that
 * decides whether a rewrite is allowed to reach a shell.
 */
export function vetRewrite(typed: string, reply: string): string | null {
  // A small model fences things, prefixes `$`, or echoes the `!`. Strip the packaging, keep the line.
  const line = reply
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('```'))[0];
  if (!line) return null;

  const cleaned = line
    .replace(/^`+|`+$/g, '')
    .replace(/^\$\s+/, '')
    .replace(/^!/, '')
    .trim();

  if (!cleaned) return null;
  if (/^ok$/i.test(cleaned)) return null;
  if (cleaned === typed) return null;
  if (cleaned.length > typed.length * MAX_GROWTH_FACTOR + MAX_GROWTH_CHARS) return null;

  // WHAT IS INSIDE QUOTES IS THE OPERATOR'S, AND NO MODEL SPELLS IT BETTER. Measured, not feared:
  // `grep -rn "wrold" src` came back as `grep -rn "world" src` — a search for a different string,
  // returning nothing, and the typo was the whole reason for the search. The prompt says so and the
  // model did it anyway, so the rule lives here. Only when the typed line HAS a closed quote pair:
  // with none, the fix on offer is the missing quote itself, which this must not veto.
  const typedQuotes = quoted(typed);
  if (typedQuotes.length && JSON.stringify(quoted(cleaned)) !== JSON.stringify(typedQuotes)) return null;

  for (const re of ESCALATIONS) {
    if (re.test(cleaned) && !re.test(typed)) return null;
  }
  if (dangerousShellOp(cleaned) !== null && dangerousShellOp(typed) === null) return null;

  return cleaned;
}

/**
 * Ask the model whether the line is spelled right, and vet whatever comes back.
 *
 * Never throws, never blocks longer than the configured budget, and never returns a command the
 * operator did not effectively type.
 */
export async function checkBangSyntax(typed: string): Promise<BangCheckResult> {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  try {
    const { getConfig } = await import('./prompts.js');
    timeoutMs = getConfig('bangCheckMs', DEFAULT_TIMEOUT_MS);
  } catch { /* the default stands */ }
  if (timeoutMs <= 0) return { command: typed, note: null };

  let timer: NodeJS.Timeout | undefined;
  try {
    const [{ llmChat }, { getPrompt }, { setLlmPurpose }, { shellName }] = await Promise.all([
      import('./llm/manager.js'),
      import('./prompts.js'),
      import('./timing.js'),
      import('./shell.js'),
    ]);
    setLlmPurpose('bang-syntax');

    const asked = llmChat(
      // The shell FAMILY, not its path: `cmd` quotes differently from bash, and the absolute path to
      // it is a fact about the operator's machine that the question does not need.
      [{ role: 'user', content: getPrompt('bangSyntax', { SHELL: /cmd/i.test(shellName()) ? 'cmd.exe' : 'bash', COMMAND: typed }) }],
      { declareTools: false },
    );
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    });

    const reply = await Promise.race([asked, timedOut]);
    if (reply === null) {
      // The command still runs. Saying so once is how the operator learns the check is not working.
      const note = failureAnnounced ? null : `syntax check took longer than ${timeoutMs}ms — running what you typed (\`/set bang-check-ms 0\` turns it off).`;
      failureAnnounced = true;
      return { command: typed, note };
    }

    const fixed = vetRewrite(typed, reply);
    if (!fixed) return { command: typed, note: null };
    return { command: fixed, note: `syntax: you typed \`${typed}\` — running \`${fixed}\`` };
  } catch {
    const note = failureAnnounced ? null : 'syntax check unavailable — running what you typed.';
    failureAnnounced = true;
    return { command: typed, note };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
