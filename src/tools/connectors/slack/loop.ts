/**
 * The Slack connector's inner agentic loop.
 *
 * SAME SHAPE AS JIRA/SENTRY, AND FOR THE SAME REASON: the protocol is ONE LINE per round, because a
 * small local model asked for JSON mid-reasoning produces malformed JSON far more often than a wrong
 * verb. Where this loop differs is the number of verbs — `search` / `read` / `thread` / `channels` /
 * `user` / `call`, one per shape of question, instead of jira/sentry's single `open` — because a Slack
 * question is rarely answered by one fetch: it is usually "find the message" (`search`) THEN "read
 * what was around it" (`read`, narrowed with the hit's `latest=`) or "read the replies" (`thread`).
 *
 * WHY NOT ONE GENERIC `slack_call({method, params})` TOOL. It works — Slack's REST surface is small
 * enough that a model can compose `search.messages` from a method name and a params object — but it
 * pays for an API reference in the prompt on every question, and it makes the model learn Slack's own
 * vocabulary before it can ask anything. Named verbs carry their own semantics: `search <query>` needs
 * no schema, `read <channel>` needs no explanation of what a "conversation" is. `call` still exists, as
 * the allowlisted escape hatch for a read method none of the five wrap (`reactions.get`, `team.info`).
 */

import { toolLlm, toolLog, toolPrompts, toolReport } from '../../runtime.js';
import {
  channelList, history, lookupUser, msgLine, rawCall, replies, search, verifyAccess, whoAmI,
} from './client.js';
import { credentialSummary, readCredentials } from './credentials.js';

/** Rounds of read-then-think. Each is one LLM call. */
const MAX_ROUNDS = 6;

/** Reads (any verb) one question may need. Past this the loop is browsing, not answering. */
const MAX_ACTIONS = 5;

/** `key=value` tokens after a command's positional arguments — `read C0123 latest=1755.02 limit=30`. */
function parseKV(rest: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf('=');
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Total budget for everything read so far, across ALL rounds. Each render is already capped
 * per-call (100 messages, 600 chars each), but five actions of a 50k-message channel can still add
 * up to hundreds of KB — a local model's context window, not Slack's page size, is the real limit
 * here. Drops the OLDEST reads first: the next round is reasoning from the most recent ones.
 */
const MAX_OBS_CHARS = 12_000;
function obsText(list: string[]): string {
  if (!list.length) return '(nothing read yet)';
  let kept = list;
  while (kept.length > 1 && kept.join('\n\n').length > MAX_OBS_CHARS) kept = kept.slice(1);
  const dropped = list.length - kept.length;
  const joined = kept.join('\n\n');
  const body = joined.length > MAX_OBS_CHARS ? joined.slice(-MAX_OBS_CHARS) : joined;
  return dropped ? `(${dropped} earlier read(s) dropped — over the context budget)\n\n${body}` : body;
}

/**
 * Run one command line against the toolkit. Returns the observation text, or `null` when the line
 * matches no known verb (including "answer", which the caller checks first).
 *
 * EVERY RENDERED BLOCK PUTS ITS CURSOR/PAGE INFO ON THE FIRST LINE, NEVER THE LAST — an observation
 * gets clipped when the prompt is over budget, and a trailing cursor is exactly what clipping eats,
 * silently ending pagination at page one.
 */
async function runCommand(line: string): Promise<string | null> {
  let m = /^\s*search\s+([\s\S]+)$/i.exec(line);
  if (m) {
    let query = m[1].trim();
    const pm = /\spage=(\d+)\s*$/i.exec(query);
    const page = pm ? Number(pm[1]) : undefined;
    if (pm) query = query.slice(0, pm.index).trim();
    try {
      const r = await search(query, { page });
      const more = r.pageCount > r.page ? `, more: "search ${query} page=${r.page + 1}"` : '';
      const head = `${r.total} match(es) total, showing ${r.matches.length} (page ${r.page}/${r.pageCount}${more})`;
      return r.matches.length ? `${head}\n${r.matches.map((mm) => msgLine(mm, true)).join('\n')}` : `${head} — nothing matched this query.`;
    } catch (err) {
      return `search failed: ${errText(err)}`;
    }
  }

  m = /^\s*read\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(line);
  if (m) {
    const channel = m[1];
    const kv = parseKV(m[2] ?? '');
    try {
      const r = await history(channel, { latest: kv.latest, cursor: kv.cursor, limit: kv.limit ? Number(kv.limit) : undefined });
      const cursorHint = r.cursor ? ` · more: "read ${channel} cursor=${r.cursor}"` : '';
      const head = `${r.messages.length} message(s) in ${channel}, oldest first${r.hasMore ? ', more available' : ''}${cursorHint}`;
      return `${head}\n${r.messages.map((mm) => msgLine(mm)).join('\n')}`;
    } catch (err) {
      return `read failed: ${errText(err)}`;
    }
  }

  m = /^\s*thread\s+(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(line);
  if (m) {
    const [, channel, ts, rest] = m;
    const kv = parseKV(rest ?? '');
    try {
      const r = await replies(channel, ts, { cursor: kv.cursor, limit: kv.limit ? Number(kv.limit) : undefined });
      const cursorHint = r.cursor ? ` · more: "thread ${channel} ${ts} cursor=${r.cursor}"` : '';
      const head = `${r.messages.length} message(s) in the thread, oldest first${r.hasMore ? ', more available' : ''}${cursorHint}`;
      return `${head}\n${r.messages.map((mm) => msgLine(mm)).join('\n')}`;
    } catch (err) {
      return `thread failed: ${errText(err)}`;
    }
  }

  m = /^\s*channels\b(?:\s+([\s\S]*))?$/i.exec(line);
  if (m) {
    const rest = m[1] ?? '';
    const kv = parseKV(rest);
    const workspace = /\bworkspace\b/i.test(rest);
    try {
      const r = await channelList({ workspace, cursor: kv.cursor });
      const cursorHint = r.cursor ? ` · more: "channels${workspace ? ' workspace' : ''} cursor=${r.cursor}"` : '';
      const head = `${r.conversations.length} conversation(s) [${r.scope}]${cursorHint}`;
      const rows = r.conversations.map(
        (c) => `${c.id}  ${c.label}${c.members != null ? ` ${c.members} members` : ''}${c.isArchived ? ' [archived]' : ''}${c.topic ? ` — ${c.topic}` : ''}`,
      );
      return `${head}\n${rows.join('\n')}`;
    } catch (err) {
      return `channels failed: ${errText(err)}`;
    }
  }

  m = /^\s*user\s+(\S+)$/i.exec(line);
  if (m) {
    try {
      const u = await lookupUser(m[1]);
      return `${u.id}  ${u.name} (@${u.handle})${u.realName ? ` — ${u.realName}` : ''}${u.title ? `, ${u.title}` : ''}`
        + `${u.isBot ? ' [bot]' : ''}${u.deleted ? ' [deleted]' : ''}`;
    } catch (err) {
      return `user failed: ${errText(err)}`;
    }
  }

  m = /^\s*call\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(line);
  if (m) {
    const method = m[1];
    const kv = parseKV(m[2] ?? '');
    try {
      const data = await rawCall(method, kv);
      const out = JSON.stringify(data);
      return out.length > 3000 ? `${out.slice(0, 3000)}…[truncated]` : out;
    } catch (err) {
      return `call failed: ${errText(err)}`;
    }
  }

  return null;
}

export async function askSlack(question: string): Promise<string> {
  const q = question.trim();
  if (!q) return 'Ask something about your Slack, e.g. /slack what has anyone said about the outage last week?';

  const prompts = toolPrompts('slack');

  let scope: string;
  try {
    toolReport('slack: checking the token → whoami');
    const who = await whoAmI();
    if (!who.isUserToken) {
      return `slack: authenticated as ${who.user} @ ${who.team}, but this is not a user token — search is `
        + 'unavailable to a bot token, and it only sees channels it was invited into. Reinstall the Slack '
        + 'app and take the User OAuth Token, then /slack-auth with it.';
    }
    scope = `${who.user} @ ${who.team}`;
  } catch (err) {
    return `slack: ${errText(err)}`;
  }
  toolReport(`slack: reading as ${scope}`);

  const observations: string[] = [];
  let lastCommand = '';
  let stalled = false;
  let actions = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // THE LAST ROUND, A STALL, OR THE ACTION BUDGET SPENT → answer-only, enforced here rather than
    // merely asked for: a model that keeps reading past the point of having enough is not thorough,
    // it is stuck, and the fix (jira/sentry, measured) is to withdraw the option rather than ask.
    const isFinal = round === MAX_ROUNDS || stalled || actions >= MAX_ACTIONS;
    const system = isFinal
      ? prompts.get('final', { SCOPE: scope, OBSERVATIONS: obsText(observations) })
      : prompts.get('loop', { SCOPE: scope });
    // THE SYSTEM MESSAGE IS THE SAME BYTES EVERY ROUND. What grows rides in the user turn, so a
    // server-side KV cache of the prompt prefix still applies on round two and three.
    const user = isFinal ? q : prompts.get('round', {
      QUESTION: q,
      OBSERVATIONS: obsText(observations),
      REMAINING: String(MAX_ROUNDS - round),
    });

    let reply: string;
    try {
      reply = (await toolLlm().ask([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ])).trim();
    } catch (err) {
      toolLog().error('slack_llm_error', { round: String(round), error: errText(err) });
      return `slack: the model call failed (${errText(err)}).`;
    }

    const answer = /^\s*answer\s*:?\s*([\s\S]+)/i.exec(reply);
    if (answer) {
      toolLog().info('slack_answered', { rounds: String(round), actions: String(actions) });
      return answer[1].trim();
    }
    if (isFinal) {
      // The final round has no protocol to mirror, so a non-answer reply here is prose, not a stray command.
      toolLog().info('slack_answered_unmarked', { rounds: String(round) });
      return reply || (observations.length
        ? `slack: the model would not summarise, so here is what it read:\n\n${observations.join('\n\n')}`
        : 'slack: could not settle on an answer.');
    }

    const norm = reply.replace(/\s+/g, ' ').trim().toLowerCase();
    if (norm && norm === lastCommand) {
      // A repeated command is a stall, not thoroughness (measured on jira/sentry, same loop shape):
      // whatever it would return is already in the observations above.
      stalled = true;
      observations.push('(that command was already run above — everything it would return is already here)');
      toolLog().warn('slack_repeat_command', { line: norm.slice(0, 80) });
      continue;
    }

    const out = await runCommand(reply);
    if (out === null) {
      observations.push('(not a recognised command or an answer — use one of: search / read / thread / channels / user / call / answer)');
      continue;
    }
    lastCommand = norm;
    actions++;
    observations.push(out);
  }

  // Never "could not settle" while holding data the operator asked for.
  toolLog().warn('slack_rounds_exhausted', { actions: String(actions) });
  return observations.length
    ? `slack: the model would not summarise, so here is what it read:\n\n${observations.join('\n\n')}`
    : 'slack: could not settle on an answer in the rounds available.';
}

/** Exported for the offline harness (`tool/check-slack.mjs`) — not part of the public surface. */
export const _internals = { runCommand, parseKV, obsText };

/** `/slack-auth` with no argument, and the connector's own health line. */
export async function slackStatus(): Promise<string> {
  const c = readCredentials();
  if (!c) return 'slack: not configured. Run /slack-auth <paste your user token> to set it up.';
  try {
    const v = await verifyAccess();
    if (!v.isUserToken) return `slack: token stored but it is NOT a user token — authenticated as ${v.who}. Reinstall the app and re-run /slack-auth with the User OAuth Token.`;
    return `slack: ${credentialSummary(c)} — authenticated as ${v.who} ✓`;
  } catch (err) {
    return `slack: ${credentialSummary(c)} — but the call FAILED: ${errText(err)}`;
  }
}
