/**
 * THE REASONING CHANNEL, WHEN THE SERVING PATH FAILS TO SPLIT IT OFF.
 *
 * A thinking model emits two channels. Normally the runtime separates them and the reasoning arrives
 * in a field of its own (Ollama's `message.thinking`), where ayin never looks — correct, because a
 * model is not meant to be shown its own prior thinking. This file is for when that separation does
 * not happen and the reasoning arrives inside `content`.
 *
 * MEASURED, not anticipated. A `qwen3.8` class model with the runtime told `think: false` reasons
 * anyway — it is a thinking-first model, and the flag does not stop it THINKING, it stops the runtime
 * emitting the open tag its parser SPLITS on. So the whole block lands in `content` behind the model's
 * OWN header, which carries no angle brackets and never closes:
 *
 *     [thinking]
 *     The user is asking for X. Let me think about how to…
 *
 * Observed as ~1400 characters of monologue with no answer after it at all, and in a different language
 * from the conversation.
 *
 * RARE, AND THAT IS THE ARGUMENT FOR A STRIP. Three replies in ~500 calls across three days, all on one
 * day, all in one image-bearing conversation. A rate that low is why this is not a setting and not a
 * model ban: you cannot reproduce it on demand to tune a flag against, it costs a whole turn when it
 * lands, and the damage is not the ugly reply — it is that the monologue is then replayed as history.
 *
 * WHY THIS COSTS MORE THAN AN UGLY REPLY. Qwen's own guidance is that historical turns must carry the
 * final output only, never the thinking. Leave the monologue in and it is replayed into every later
 * prompt, so the window grows and the model is primed to do it again — and `agent.ts` already spells
 * out the mechanism for a neighbouring bug: anything sitting in an assistant turn is a worked example
 * the model will imitate. It is also where the "qwen is slow" complaint comes from; the tokens are
 * real and they are spent on text nobody wanted.
 *
 * DELIBERATELY NARROW. Two shapes only, and the bare `[thinking]` one is anchored to the start of a
 * line, so an answer that merely MENTIONS the word — or a diff, or a log excerpt quoting it — is
 * untouched. Over-stripping here would eat a real answer, which is worse than the leak.
 */

/** A well-formed block: `<think>…</think>` / `<thinking>…</thinking>`, anywhere in the text. */
const CLOSED = /<\s*think(?:ing)?\b[^>]*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi;

/**
 * An opener that never closes. Everything after it is reasoning BY CONSTRUCTION: with no closing tag
 * the generation never returned to the answer channel, so there is nothing after it to keep.
 */
const UNCLOSED_TAG = /<\s*think(?:ing)?\b[^>]*>[\s\S]*$/i;

/**
 * The bare header form, which carries no angle brackets at all and therefore defeats every
 * tag-shaped guard. Anchored to a line of its own — `[thinking]` inside a sentence is prose.
 */
const UNCLOSED_HEADER = /(?:^|\r?\n)[ \t]*\[[ \t]*thinking[ \t]*\][ \t]*(?:\r?\n[\s\S]*)?$/i;

/**
 * A REPLY THAT IS DATA IS NEVER A MONOLOGUE — leave it entirely alone.
 *
 * `llmChat` is the single door, so this runs for all 33 call sites, and many of them ask for JSON:
 * explore, indulge, the QA judges, plan drafting, the connector loops. Those replies cannot contain a
 * leaked channel — the leak is prose, and a model that emitted one did not also produce parseable
 * JSON around it. What they CAN contain is a `<think>` tag inside a string value, in exactly the
 * replies that discuss this bug: a QA note reading `"the model emitted <think> tags"` would otherwise
 * be truncated from that tag to the end, and hand the caller a JSON syntax error instead of an answer.
 *
 * Parsing is the check because it is exact. A structural guess ("starts with a brace") would still
 * mangle prose that opens with one.
 */
function isStructured(raw: string): boolean {
  const t = raw.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

/**
 * Is the offset inside a fenced code block?
 *
 * Same reasoning `unexecutedCallText` already applies to invented tool calls: an answer that SHOWS a
 * construct while explaining it must not be treated as emitting one. A fenced log excerpt or a code
 * sample containing `[thinking]` or `<think>` is documentation, and eating everything after it would
 * delete the answer that was being illustrated.
 */
function insideFence(raw: string, index: number): boolean {
  let fences = 0;
  for (let i = raw.indexOf('```'); i !== -1 && i < index; i = raw.indexOf('```', i + 3)) fences++;
  return fences % 2 === 1;
}

/** Apply an "everything from here to the end is reasoning" pattern, unless the opener is in a fence. */
function dropFromOpener(raw: string, re: RegExp): string {
  const m = re.exec(raw);
  if (!m || m.index === undefined) return raw;
  return insideFence(raw, m.index) ? raw : raw.slice(0, m.index);
}

/**
 * Remove a leaked reasoning channel from a raw model reply.
 *
 * MAY RETURN EMPTY, and that is the point: a reply that was nothing but reasoning contains no answer,
 * and saying so lets the agent loop notice and ask again (bounded by its own nudge cap). The
 * alternative — keeping the monologue so the text is non-empty — is what puts it in the window, which
 * is the failure this exists to stop. Maradel's chat path makes the opposite choice on purpose: a
 * chat bubble with a monologue beats an empty bubble, and there is no loop there to re-ask.
 */
export function stripReasoning(raw: string): string {
  if (!raw || isStructured(raw)) return raw;
  // Closed blocks first: a well-formed block is unambiguous wherever it sits, EXCEPT in a fence,
  // where it is a quoted example. Removing them first also stops a closed block's own opening tag
  // being mistaken for an unterminated one below.
  let out = raw.replace(CLOSED, (block, ...rest) => {
    const index = rest[rest.length - 2] as number;
    return insideFence(raw, index) ? block : '';
  });
  out = dropFromOpener(out, UNCLOSED_TAG);
  out = dropFromOpener(out, UNCLOSED_HEADER);
  return out.trim();
}
