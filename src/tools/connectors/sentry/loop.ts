/**
 * The sentry connector's inner agentic loop.
 *
 * Same shape as the jira connector, for the same reasons: the unresolved-issue list is fetched ONCE up
 * front (most questions about what is broken are answered by it), the protocol is one line per round
 * (`open <ID>` / `answer <text>`), and scope is checked against the fetched set rather than requested in
 * a prompt.
 *
 * The difference is what `open` costs. In Jira it fetches a ticket; here it fetches an EVENT — the
 * stacktrace — which is the expensive, useful thing, and the reason a question like "why is X failing"
 * can be answered at all rather than just "X is failing 400 times".
 */

import { toolLlm, toolLog, toolPrompts, toolReport } from '../../runtime.js';
import { latestEvent, unresolvedIssues, type SentryIssue } from './client.js';
import { credentialSummary, readCredentials } from './credentials.js';

const MAX_ROUNDS = 5;

/**
 * Issues whose stacktrace one question may need. Two covers "why is X failing" and "how do X and Y
 * differ"; past that the loop is browsing, not answering, and each open costs a round and a payload.
 */
const MAX_OPENS = 2;

function fmtLine(i: SentryIssue): string {
  const users = i.userCount ? ` · ${i.userCount} user${i.userCount === 1 ? '' : 's'}` : '';
  const where = i.culprit ? ` · ${i.culprit}` : '';
  return `${i.shortId} · ${i.level || '?'} · ${i.count} events${users} · last ${i.lastSeen}${where}\n    ${i.title}`;
}

export async function askSentry(question: string): Promise<string> {
  const q = question.trim();
  if (!q) return 'Ask a question about what is failing, e.g. /sentry what is breaking most for users?';

  const prompts = toolPrompts('sentry');
  let issues: SentryIssue[];
  try {
    toolReport('sentry: reading unresolved issues');
    issues = await unresolvedIssues();
  } catch (err) {
    return `sentry: ${err instanceof Error ? err.message : String(err)}`;
  }

  const c = readCredentials();
  const scope = c ? credentialSummary(c) : '';
  if (issues.length === 0) return `sentry: no unresolved issues in the last 14 days (${scope}).`;
  toolReport(`sentry: ${issues.length} unresolved → answering`);

  // Both ids are accepted from the model: it sees short ids, but a numeric one is not a mistake worth
  // a round to correct.
  const byKey = new Map<string, SentryIssue>();
  for (const i of issues) {
    byKey.set(i.shortId.toUpperCase(), i);
    if (i.id) byKey.set(i.id, i);
  }

  const list = issues.map(fmtLine).join('\n');
  const observations: string[] = [];
  const opened = new Set<string>();
  /**
   * Set when the model asks to re-open something it has already read.
   *
   * That is not thoroughness, it is a stall — and a measured one: asked "open the top issue and tell me
   * what happened", the model mirrored the word "open" from the question and re-emitted the same command
   * every round, with the answer already sitting in its context. ayin's own tool guard learned this
   * lesson first ("a second identical call is BLOCKED, not warned"), so the repeat ends the gathering
   * phase outright rather than earning another warning it will ignore.
   */
  let stalled = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    /**
     * THE LAST ROUND IS ANSWER-ONLY, and mechanically so.
     *
     * Measured: asked to open an issue and explain it, the model opened one, then kept opening — five
     * rounds of `open`, and the operator got "could not settle on an answer" while the loop was holding
     * everything needed to answer. A prompt asking it to wrap up is a request; removing the option is
     * not. So on the final round the alternative is withdrawn in the prompt AND `open` is ignored below,
     * because a rule the harness does not enforce is a rule the model can decline.
     */
    const isFinal = round === MAX_ROUNDS || stalled || opened.size >= MAX_OPENS;
    /**
     * The answer-only round uses a DIFFERENT prompt, one that contains no protocol at all.
     *
     * Telling the model `open` is unavailable did not stop it emitting `open` — because the word was in
     * the operator's own question ("open the top issue and tell me…") and it was mirroring, not
     * choosing. Measured: three rounds of `open` with the answer already in context. A prompt that
     * mentions no commands has nothing to mirror, which fixes the cause rather than forbidding the
     * symptom.
     */
    const system = isFinal
      ? prompts.get('final', {
        SCOPE: scope,
        ISSUES: list,
        OBSERVATIONS: observations.length ? observations.join('\n\n') : '(none — answer from the list)',
      })
      : prompts.get('loop', {
        SCOPE: scope,
        ISSUES: list,
        OBSERVATIONS: observations.length ? observations.join('\n\n') : '(no stacktrace opened yet)',
        REMAINING: String(MAX_ROUNDS - round),
        FINAL_NOTICE: '',
      });

    let reply: string;
    try {
      reply = (await toolLlm().ask([
        { role: 'system', content: system },
        { role: 'user', content: q },
      ])).trim();
    } catch (err) {
      toolLog().error('sentry_llm_error', { round: String(round), error: String(err) });
      return `sentry: the model call failed (${err instanceof Error ? err.message : String(err)}). `
        + `Unresolved issues, unread:\n\n${list}`;
    }

    const open = isFinal ? null : /^\s*open\s+([A-Za-z0-9_-]+)/i.exec(reply);
    if (open) {
      const key = open[1].toUpperCase();
      const issue = byKey.get(key) ?? byKey.get(open[1]);
      if (!issue) {
        observations.push(`${open[1]} is not in the unresolved list, so it cannot be opened. Only these exist: ${issues.map((i) => i.shortId).join(', ')}`);
        toolLog().warn('sentry_out_of_scope', { key: open[1] });
        continue;
      }
      if (opened.has(issue.shortId)) {
        stalled = true; // the next round is answer-only; see the declaration
        observations.push(`${issue.shortId} was already opened above — everything known about it is already here.`);
        toolLog().warn('sentry_repeat_open', { key: issue.shortId });
        continue;
      }
      try {
        toolReport(`sentry: opening ${issue.shortId}`);
        const ev = await latestEvent(issue.id);
        opened.add(issue.shortId);
        // A stack when there is one, the breadcrumb trail when there is not — and the absence is stated
        // rather than left as an empty section the model might fill in with a plausible guess.
        const stack = ev.frames.length
          ? `Stack, crash first:\n${ev.frames.map((f) => `  ${f}`).join('\n')}`
            + `${ev.framesOmitted ? `\n  … ${ev.framesOmitted} further frame(s) omitted` : ''}`
          : 'No stacktrace: this event is a LOGGED error, not a crash.';
        const trail = ev.breadcrumbs.length
          ? `\nLog leading up to it${ev.breadcrumbsOmitted ? ` (last ${ev.breadcrumbs.length} of ${ev.breadcrumbs.length + ev.breadcrumbsOmitted})` : ''}:\n`
            + ev.breadcrumbs.map((b) => `  ${b}`).join('\n')
          : '';
        observations.push(
          `${issue.shortId} — ${issue.title}\n`
          + `${ev.exception ? `Exception: ${ev.exception}\n` : ''}`
          + `${ev.message ? `Message: ${ev.message}\n` : ''}`
          + `${ev.tags.length ? `Tags: ${ev.tags.join(' ')}\n` : ''}`
          + `Latest event ${ev.timestamp}. ${stack}${trail}`,
        );
      } catch (err) {
        observations.push(`${issue.shortId} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    const answer = /^\s*answer\s*:?\s*([\s\S]+)/i.exec(reply);
    if (answer) {
      toolLog().info('sentry_answered', { rounds: String(round), opened: String(opened.size) });
      return answer[1].trim();
    }
    // A reply that is still a COMMAND on the final round is not an answer, and returning it as one would
    // print `open PLAY-…` to the operator as though it were prose.
    if (reply && !/^\s*open\b/i.test(reply)) {
      toolLog().info('sentry_answered_unmarked', { rounds: String(round) });
      return reply;
    }
    observations.push('(that was not an answer — answer the question from what is above)');
  }

  // Never "could not settle" while holding the data: whatever was opened is what the operator wanted to
  // see, so it is handed over raw rather than discarded because the model would not summarise it.
  toolLog().warn('sentry_rounds_exhausted', { opened: String(opened.size) });
  return observations.length
    ? `sentry: the model would not summarise, so here is what it read:\n\n${observations.join('\n\n')}`
    : `sentry: could not settle on an answer in ${MAX_ROUNDS} rounds. Unresolved issues:\n\n${list}`;
}

/** `/sentry-auth` with no argument, and the connector's own health line. */
export async function sentryStatus(): Promise<string> {
  const c = readCredentials();
  if (!c) return 'sentry: not configured. Run /sentry-auth <paste your token and org> to set it up.';
  if (!c.org) return `sentry: token stored but no organization — run /sentry-auth <your-org-slug>.`;
  try {
    const { verifyAccess } = await import('./client.js');
    await verifyAccess();
    return `sentry: ${credentialSummary(c)} — token accepted ✓`;
  } catch (err) {
    return `sentry: ${credentialSummary(c)} — but the call FAILED: ${err instanceof Error ? err.message : String(err)}`;
  }
}
