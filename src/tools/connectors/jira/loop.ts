/**
 * The jira connector's inner agentic loop.
 *
 * A connector is not a getter with a model bolted on: the operator asks a question in their own words
 * ("what's left on me?", "did anyone answer my question on the login bug?") and the loop decides how
 * much Jira it has to read to answer it. It is its own small agent, so the OUTER agent spends no rounds
 * on Jira mechanics.
 *
 * THE SPRINT LIST IS FETCHED ONCE, UP FRONT. Most questions about a sprint are answered by the list of
 * tickets in it, so paying for that fetch unconditionally makes the common case a single LLM call, and
 * gives every later round the same fixed frame of reference. Only a question that needs a ticket's
 * description or comments costs another round.
 *
 * SCOPE IS CHECKED AGAINST THE FETCHED SET, NOT THE PROMPT. `open KEY` is refused unless KEY is in the
 * operator's current sprint. A prompt saying "only your sprint" is a request; this is the answer being
 * unavailable. The model is told why, so it corrects rather than retries.
 *
 * THE PROTOCOL IS ONE LINE. This loop drives whatever local model ayin is pointed at, and a small model
 * asked for structured output mid-reasoning produces malformed JSON far more often than it produces a
 * wrong verb. `open KEY` / `answer <text>` costs nothing to emit and cannot be half-parsed.
 */

import { toolLlm, toolLog, toolPrompts, toolReport } from '../../runtime.js';
import { currentSprintIssues, issueDetail, whoAmI, type JiraIssue } from './client.js';
import { credentialSummary, daysUntilExpiry, readCredentials } from './credentials.js';

/** Rounds of read-then-think. Each is one LLM call; the list alone answers most questions in round 1. */
const MAX_ROUNDS = 5;

/** Tickets one question may need to read in full. Past two the loop is browsing, not answering. */
const MAX_OPENS = 2;

function fmtLine(i: JiraIssue): string {
  return `${i.key} · ${i.status} · ${i.issueType}/${i.priority} · ${i.title}`;
}

function fmtDetail(i: JiraIssue): string {
  const comments = i.comments?.length
    ? i.comments.map((c) => `  - ${c.author} (${c.created}): ${c.body}`).join('\n')
    : '  (no comments)';
  return `${fmtLine(i)}\nDescription:\n${i.description}\nComments (${i.comments?.length ?? 0}):\n${comments}`;
}

/**
 * Warn when the operator's own recorded expiry is close. Advisory, and deliberately not an error: the
 * server is the authority on whether a token still works, and a wrong note must never block a call that
 * would have succeeded.
 */
function expiryNote(): string {
  const c = readCredentials();
  if (!c) return '';
  const days = daysUntilExpiry(c);
  if (days === null || days > 7) return '';
  return days < 0
    ? `\n\n[jira] your recorded token expiry passed ${-days}d ago — if calls start failing, run /jira-auth with a fresh token.`
    : `\n\n[jira] your Jira token expires in ${days}d — /jira-auth with a fresh one when convenient.`;
}

/** Answer a question about the operator's current sprint. Never throws; returns the failure as text. */
export async function askJira(question: string): Promise<string> {
  const q = question.trim();
  if (!q) return 'Ask a question about your current sprint, e.g. /jira what is still open on me?';

  const prompts = toolPrompts('jira');
  let me: { name: string; email: string };
  let issues: JiraIssue[];
  let scope = '';
  try {
    toolReport('jira: identifying the token owner');
    me = await whoAmI();
    toolReport(`jira: ${me.name} → reading your current sprint`);
    ({ issues, scope } = await currentSprintIssues());
  } catch (err) {
    return `jira: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (issues.length === 0) {
    return `jira: nothing assigned to ${me.name} in the active sprint (${scope}).${expiryNote()}`;
  }
  toolReport(`jira: ${issues.length} ticket(s) in ${scope} → answering`);

  const inSprint = new Map(issues.map((i) => [i.key.toUpperCase(), i]));
  const sprintList = issues.map(fmtLine).join('\n');
  const observations: string[] = [];
  const opened = new Set<string>();

  // A KEY THE OPERATOR ALREADY NAMED COSTS NO ROUND TO DISCOVER.
  //
  // "solve 13804" names the ticket. Spending a full model call — with the sprint list in the prompt —
  // to have the model reply with that same key is asking it to repeat what was in the question, and it
  // is the slowest call of the turn because the reply gates everything after it. Matched against the
  // FETCHED SET, so scope is still decided by what Jira returned and never by the prompt: a bare
  // number resolves only if exactly one sprint ticket ends in it, and an ambiguous one is left to the
  // model rather than guessed at.
  for (const raw of q.match(/\b([A-Za-z][A-Za-z0-9_]*-)?\d{2,}\b/g) ?? []) {
    if (opened.size >= MAX_OPENS) break;
    const token = raw.toUpperCase();
    const hits = token.includes('-')
      ? (inSprint.has(token) ? [token] : [])
      : [...inSprint.keys()].filter((k) => k.endsWith(`-${token}`));
    if (hits.length !== 1 || opened.has(hits[0])) continue;
    try {
      toolReport(`jira: opening ${hits[0]} (named in the question)`);
      const detail = await issueDetail(hits[0]);
      opened.add(hits[0]);
      observations.push(fmtDetail(detail));
    } catch (err) {
      observations.push(`${hits[0]} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  /**
   * Set when the model asks to re-open something it has already read — a stall, not thoroughness.
   * Measured on the sentry connector, which shares this loop's shape: the model mirrored the word
   * "open" out of the question and re-emitted the same command every round with the answer already in
   * its context. The repeat ends the gathering phase instead of earning a warning it ignores.
   */
  let stalled = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // The last round is ANSWER-ONLY, enforced here and not merely asked for in the prompt. Measured on
    // the sentry connector, which shares this shape: told to open a ticket and explain it, the model
    // opened one and then kept opening, and the operator got "could not settle" from a loop that was
    // holding everything it needed. Withdrawing the option is the only version the model cannot decline.
    const isFinal = round === MAX_ROUNDS || stalled || opened.size >= MAX_OPENS;
    /**
     * The answer-only round uses a DIFFERENT prompt, containing no protocol at all. Telling the model
     * `open` was unavailable did not stop it emitting `open` — the word was in the operator's own
     * question and it was mirroring, not choosing. A prompt that mentions no commands has nothing to
     * mirror. (Measured on the sentry connector; this loop shares the shape and the failure.)
     */
    // THE SYSTEM MESSAGE IS THE SAME BYTES EVERY ROUND. What grows — the tickets read so far, the
    // rounds left — rides in the USER turn, at the end.
    //
    // A server caches the KV state of a prompt PREFIX. Putting OBSERVATIONS and a decrementing
    // counter in the system message guaranteed a different prefix on every round, so each round
    // reprocessed the whole prompt — sprint list, ticket description and comments included — instead
    // of appending to what was already computed. Rounds two and three are where this loop spends its
    // time, and they were the two paying full price.
    const system = isFinal
      ? prompts.get('final', {
        ME: me.name,
        SPRINT: sprintList,
        OBSERVATIONS: observations.length ? observations.join('\n\n') : '(none — answer from the list)',
      })
      : prompts.get('loop', { ME: me.name, SPRINT: sprintList });

    const user = isFinal ? q : prompts.get('round', {
      QUESTION: q,
      OBSERVATIONS: observations.length ? observations.join('\n\n') : '(nothing opened yet)',
      REMAINING: String(MAX_ROUNDS - round),
    });

    let reply: string;
    try {
      reply = (await toolLlm().ask([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ])).trim();
    } catch (err) {
      toolLog().error('jira_llm_error', { round: String(round), error: String(err) });
      return `jira: the model call failed (${err instanceof Error ? err.message : String(err)}). `
        + `Your sprint, unread:\n\n${sprintList}`;
    }

    const open = isFinal ? null : /^\s*open\s+([A-Za-z][A-Za-z0-9_]*-\d+)/i.exec(reply);
    if (open) {
      const key = open[1].toUpperCase();
      if (!inSprint.has(key)) {
        // Refused, with the reason and the actual options — a bare "no" gets retried verbatim.
        observations.push(`${key} is NOT in your current sprint, so it cannot be opened. Only these exist: ${[...inSprint.keys()].join(', ')}`);
        toolLog().warn('jira_out_of_scope', { key });
        continue;
      }
      if (opened.has(key)) {
        // Already on the board. Re-fetching cannot change the answer within one turn, and a model that
        // asks twice is stuck, not thorough — so gathering ends here.
        stalled = true;
        observations.push(`${key} was already opened above — everything known about it is already here.`);
        toolLog().warn('jira_repeat_open', { key });
        continue;
      }
      try {
        toolReport(`jira: opening ${key}`);
        const detail = await issueDetail(key);
        opened.add(key);
        observations.push(fmtDetail(detail));
      } catch (err) {
        observations.push(`${key} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    const answer = /^\s*answer\s*:?\s*([\s\S]+)/i.exec(reply);
    if (answer) {
      toolLog().info('jira_answered', { rounds: String(round), opened: String(opened.size) });
      return answer[1].trim() + expiryNote();
    }

    // Neither verb. Take it as the answer rather than burning a round on protocol correction — the
    // model has the sprint in front of it, and a reply that is not a command is a reply. Except a
    // lingering `open` on the final round, which would print a command to the operator as prose.
    if (reply && !/^\s*open\b/i.test(reply)) {
      toolLog().info('jira_answered_unmarked', { rounds: String(round) });
      return reply + expiryNote();
    }
    observations.push('(that was not an answer — answer the question from what is above)');
  }

  // Never "could not settle" while holding the data the operator asked for.
  toolLog().warn('jira_rounds_exhausted', { opened: String(opened.size) });
  return (observations.length
    ? `jira: the model would not summarise, so here is what it read:\n\n${observations.join('\n\n')}`
    : `jira: could not settle on an answer in ${MAX_ROUNDS} rounds. Your current sprint:\n\n${sprintList}`)
    + expiryNote();
}

/** `/jira-auth` with no argument, and the connector's own health line. */
export async function jiraStatus(): Promise<string> {
  const c = readCredentials();
  if (!c) return 'jira: not configured. Run /jira-auth <paste your token and site> to set it up.';
  try {
    const me = await whoAmI();
    return `jira: ${credentialSummary(c)} — authenticated as ${me.name}${me.email ? ` <${me.email}>` : ''} ✓`;
  } catch (err) {
    return `jira: ${credentialSummary(c)} — but the call FAILED: ${err instanceof Error ? err.message : String(err)}`;
  }
}
