/**
 * bash-to-grep.ts — a shell grep is rewritten into the grep TOOL, deterministically.
 *
 * WHY, measured: One run made 900 rounds with 863 `bash` calls against 37 `read_file`. A large
 * share of those bash calls are greps, and a shell grep is a dead end for everything downstream — its
 * output is a blob of text, so the file-view machinery cannot tell it names files, the corpus cannot
 * attach what it knows about them, and the result cannot be deduplicated by region. The grep TOOL
 * returns the same answer as structured, ranked, path-addressed hits that all of that can key on.
 *
 * The rewrite is deterministic, not a nudge in a prompt. A prompt asking the model to prefer a tool is
 * a request; this is a fact about what happens. `grep` is not even in the headless tool set (it costs
 * 635 tokens of schema, three times `bash`) — the agent keeps asking in shell and gets the tool anyway.
 *
 * CONSERVATIVE BY CONSTRUCTION. Only a bare grep is rewritten: optionally prefixed by one `cd <path> &&`,
 * and with nothing after it. A pipe, a redirect, a second command, `xargs`, `$(...)` — anything that
 * means the grep is a stage rather than the question — is left alone and runs as shell, because the
 * agent asked for a pipeline and half a pipeline is worse than none.
 */

export interface GrepRewrite {
  params: Record<string, string>;
  /** For the log and for telling the model what happened. */
  why: string;
}

/** Anything that makes the grep part of a larger shell expression rather than the whole request. */
/**
 * Anything that makes the grep part of a larger shell expression rather than the whole request.
 *
 * ANY `&&` AFTER THE GREP DISQUALIFIES IT. The first version wrote `&&(?![^&]*$)`, which only fires on
 * the SECOND `&&` — so `grep -rn "x" src/ && git reset --hard` passed this check and was refused further
 * down only because `&&` and `git` counted as extra path arguments. That is safety by coincidence, and
 * the coincidence breaks the moment the tail is short enough to fit: the failure mode is that we run the
 * grep, drop the rest, and hand back a result that makes the model believe a command it never ran did.
 *
 * The one legitimate `&&` is the `cd <path> &&` prefix, and that is consumed before this test runs.
 */
const COMPOUND = /[|><;`]|\$\(|&&|\|\||\bxargs\b|\bwhile\b|\bfor\b/;

/**
 * `-n` is not in here on purpose: the tool always reports line numbers, so asking for them is a no-op
 * rather than a reason to refuse the rewrite. Same for `-r`/`-R`, which the tool does by default.
 */
const FLAG_MAP: Record<string, [string, string]> = {
  '-i': ['ignore_case', 'true'],
  '-F': ['fixed', 'true'],
  '-l': ['files_only', 'true'],
  '-c': ['count', 'true'],
  '-o': ['only_matching', 'true'],
  '-v': ['invert', 'true'],
};

/** Split a command respecting single and double quotes, so a pattern with spaces survives. */
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * A bash command that IS a grep → tool params. `null` when it is anything else, which is most commands.
 */
export function grepRewrite(command: string): GrepRewrite | null {
  let cmd = command.trim();
  if (!cmd) return null;

  // One leading `cd <path> &&` is allowed — it is how the agent scopes a search, not a pipeline.
  let base = '';
  const cd = /^cd\s+(\S+)\s*&&\s*(.*)$/s.exec(cmd);
  if (cd) { base = cd[1]; cmd = cd[2].trim(); }

  /**
   * ONE TRAILING `| head -N` IS NOT A PIPELINE — it is `max_matches`, spelled in shell.
   *
   * Measured: the first build refused every grep the agent actually wrote, because its idiom is
   * invariably `grep -n "x" path | head -30`. Zero rewrites across 127 bash calls. The pipe is the
   * model capping output, which is the one thing the tool already does better (it ranks first, then
   * caps). So strip exactly one trailing head and carry the count across; anything else still refuses.
   */
  const head = /^(.*?)\s*\|\s*head(?:\s+-n)?(?:\s+-?(\d+))?\s*$/s.exec(cmd);
  let headCap = '';
  if (head) { cmd = head[1].trim(); headCap = head[2] ?? '10'; }

  if (COMPOUND.test(cmd)) return null;
  const tokens = tokenize(cmd);
  if (tokens.length < 2) return null;
  const prog = tokens[0];
  if (!/^(grep|egrep|fgrep|rg)$/.test(prog)) return null;

  const params: Record<string, string> = {};
  if (prog === 'fgrep') params.fixed = 'true';

  const rest: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--include' || t === '--glob') { params.include = tokens[++i] ?? ''; continue; }
    if (t.startsWith('--include=')) { params.include = t.slice(10); continue; }
    if (t === '-A' || t === '-B' || t === '-C') { params.context = tokens[++i] ?? '3'; continue; }
    if (t === '-m' || t === '--max-count') { params.max_matches = tokens[++i] ?? '50'; continue; }
    if (t === '-e') { rest.push(tokens[++i] ?? ''); continue; }
    if (t.startsWith('--')) continue;                       // a long flag we do not model: ignore it
    if (t.startsWith('-') && t.length > 1) {
      // A bundle like -rn or -rin: every letter must be one we understand, or we refuse the rewrite.
      for (const ch of t.slice(1)) {
        if (ch === 'r' || ch === 'R' || ch === 'n' || ch === 'H') continue;  // the tool does these anyway
        const mapped = FLAG_MAP[`-${ch}`];
        if (!mapped) return null;
        params[mapped[0]] = mapped[1];
      }
      continue;
    }
    rest.push(t);
  }

  if (rest.length === 0) return null;
  params.pattern = rest[0];
  // No path given means "here", which under a `cd` prefix is that directory.
  const path = rest[1] ?? base ?? '.';
  params.path = rest.length > 1 && base ? `${base.replace(/\/$/, '')}/${path}`.replace(/\/\.$/, '') : path;
  if (rest.length > 2) return null;   // multiple paths: the tool takes one, so let the shell have it
  if (headCap && !params.max_matches) params.max_matches = headCap;

  return { params, why: `${prog} → grep tool` };
}
