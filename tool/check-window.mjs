/**
 * check-window.mjs — the context window must be evicted in ONE BITE, not one message per round.
 *
 * This is a PERFORMANCE contract, and it is invisible in any output: an agent that trims to exactly
 * the budget is correct in every answer it gives and takes 27 seconds per round to give it, because
 * the server's KV cache matches nothing after the first evicted message and reprocesses the whole
 * prompt. Measured through the gateway: 920 prompt tokens -> 0.56s, 17,594 -> 26.9s.
 *
 * So the gate asserts the property that keeps the cache alive: after a trim, there is HEADROOM — the
 * next rounds can append without evicting again.
 */
import { trimToContext } from '../dist/agent.js';

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const msg = (role, chars) => ({ role, content: 'x'.repeat(chars) });

// CONSERVATIVE_CONTEXT is 16384 when no model has resolved; reserve is 2000; 3 chars per token.
const CTX = 16384, RESERVE = 2000, CPT = 3;
const budget = CTX - RESERVE;
const tokens = (ms) => ms.reduce((n, m) => n + Math.ceil(m.content.length / CPT), 0);

// A window well over budget: system + 60 history messages + the volatile turn.
const history = Array.from({ length: 60 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 1500));
const messages = [msg('system', 3000), ...history, msg('user', 600)];
if (tokens(messages) <= budget) fail('fixture is not over budget — the gate would prove nothing');

const trimmed = trimToContext(messages);
const after = tokens(trimmed);
if (after > budget) fail(`trim left ${after} tokens, over the ${budget} budget`);

// THE POINT: headroom. Trimming to exactly the budget re-evicts every round and kills the cache.
const headroom = budget - after;
if (headroom < budget * 0.15) {
  fail(`trimmed to ${after}/${budget} — only ${headroom} tokens of headroom, so the next round evicts again `
     + 'and the KV cache is invalidated every round (this is the 27s-per-round bug)');
}

// The system message must survive untouched — it is the cached prefix.
if (trimmed[0].content !== messages[0].content) fail('the system message was altered or dropped');
// The volatile turn (this round's instruction) must survive.
if (trimmed[trimmed.length - 1].content !== messages[messages.length - 1].content) {
  fail('the last message (this round\'s instruction) was dropped');
}

// Under budget: nothing may be touched at all.
const small = [msg('system', 300), msg('user', 300)];
if (trimToContext(small).length !== 2) fail('a window under budget was trimmed');

console.log(`check-window: OK — trimmed to ${after}/${budget} tokens, ${headroom} of headroom, prefix intact`);
