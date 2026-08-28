/**
 * announced.ts — "I'll rewrite that file now." And then the turn ended.
 *
 * The third failure in this family, after `deferral.ts` ("the fix is to locate X") and `edit-truth.ts`
 * ("Fixed by reordering the Dispose calls" — with nothing written). Those two catch a reply that hands
 * the work back, and one that claims work already done. This catches the one in between: a reply that
 * PROMISES the work, in the future tense, and stops.
 *
 * MEASURED IN MARADEL, 2026-08-21, and named there as *the single biggest source of "why do I have to
 * nudge him"*: «Сейчас перепишу.» · «Погоди секунду.» · «Я создам файл в ~/shared/naamah-phone/README.md.»
 * · «Давай я сейчас попробую проверить…» — every one ended the turn, and every one was followed by the
 * operator typing "Ну?" or "Але" or "Где ты создал".
 *
 * WHY AYIN'S EXISTING NUDGES DO NOT CATCH IT. The continue-nudge fires on a MISSING `$` marker — a reply
 * the harness could not classify. A promise arrives *with* the marker: `$Сейчас перепишу файл.` is a
 * well-formed final answer by every mechanical test, and the model means it as one. The marker says "I
 * am done"; the sentence says "I am about to". The convention cannot see the contradiction, because the
 * contradiction is in the prose.
 *
 * THE INTENT MUST BE IN THE LAST SENTENCE, which is the whole precision of this check.
 * "Let me explain how the scheduler works: <300 words>" opens with an intent and DELIVERS it. "I looked
 * at three files and found the leak in Dispose(); I'll write that up next." delivers and then promises.
 * Only a reply whose FINAL sentence is the promise has substituted the promise for the work.
 *
 * SHORT, TOO. A promise buried at the end of a real answer is a note about what comes next; a promise
 * that IS the answer is short, because there is nothing else in it. Maradel's threshold was 600
 * characters and is kept.
 *
 * AND ONLY WHEN NOTHING RAN. A turn that edited a file has done something, whatever it says about what
 * comes next — the same escape hatch `looksLikeDeferral` takes, and for the same reason: nagging a
 * reply that did the work trains the operator to ignore the nudge.
 */

/** How long a reply can be and still be nothing but its promise. Measured in Maradel. */
const MAX_CHARS = 600;

/**
 * A sentence that announces work rather than reporting it.
 *
 * Both languages, because the operator writes in both and the model answers in the one it was asked in.
 * Deliberately anchored on FIRST PERSON + FUTURE: "the file will be rewritten" in a summary of what
 * happened is not a promise, and "you should rewrite it" is advice, which `deferral.ts` already owns.
 */
const PROMISE = new RegExp([
  // English: I'll / let me / I am going to / one moment …
  String.raw`\b(?:i(?:'m| am)\s+going\s+to|i'?ll|i\s+will|let\s+me|allow\s+me\s+to|give\s+me\s+a\s+(?:second|moment|minute))\b`,
  String.raw`\b(?:one\s+(?:second|moment)|hold\s+on|stand\s+by|coming\s+right\s+up)\b`,
  // Russian / Ukrainian. NO `\b` HERE, deliberately: JavaScript's word boundary is ASCII-only, so
  // `\bсейчас\b` never matches — there is no boundary between the start of a string and a Cyrillic
  // letter as far as `\b` is concerned. Every Cyrillic case in the gate failed on exactly that.
  // `(?<![\p{L}])` with the `u` flag is the boundary that actually works for these alphabets.
  String.raw`(?<!\p{L})(?:сейчас|щас|зараз)(?!\p{L})`,
  String.raw`(?<!\p{L})давай(?:те)?\s+я(?!\p{L})`,
  String.raw`(?<!\p{L})я\s+(?:сейчас\s+|зараз\s+)?(?:созда|напиш|перепиш|сдела|провер|запущ|добав|исправ|поищ|гляну|подивл|перевір)`,
  String.raw`(?<!\p{L})(?:погоди|подожди|зачекай|секунд|хвилин)`,
  String.raw`(?<!\p{L})(?:попробую|спробую|подивлюся|посмотрю)`,
].join('|'), 'iu');

/**
 * A promise that is really a completed statement of intent, delivered in the same reply.
 *
 * "Let me explain: …" and "I'll summarise what I found: …" are answers whose first words happen to be
 * future tense. The colon (or a dash, or a newline into a list) is the tell that the delivery follows,
 * and it is why the LAST-SENTENCE rule below is stated as "the promise is the last thing said".
 */
function deliversInline(sentence: string): boolean {
  // A COLON or a code fence, and nothing else. This was `[:—-]` and it was wrong twice over: an em-dash
  // is ordinary mid-sentence punctuation ("That makes sense — I am going to check the Dispose path"
  // reads as a promise and was being waved through), and a hyphen appears inside half the identifiers
  // a coding agent types.
  return /:\s*\S/.test(sentence) || /```/.test(sentence);
}

/** The last non-empty sentence, which is the only one this check looks at. */
function lastSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  // Split on sentence enders followed by whitespace, keeping it crude on purpose: a model's punctuation
  // is not reliable enough to justify a parser, and the fallback (the whole reply) is the safe one.
  const parts = trimmed.split(/(?<=[.!?…])\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : trimmed;
}

/**
 * True when this reply LOOKS like an announcement rather than an answer.
 *
 * THE CHEAP HALF. This is a pre-filter, not the verdict — see `reallyFinished`. A regex knows the
 * phrasings it was given and nothing else, and the ways a model can say "hold on" are not enumerable
 * across two languages. What it is good for is deciding when NOT to spend a model call, which is
 * almost every turn.
 *
 * @param text     the final answer, marker already stripped
 * @param didWork  whether ANY tool ran this turn — the escape hatch
 */
export function announcedWithoutActing(text: string, didWork: boolean): boolean {
  if (didWork) return false;
  const trimmed = (text ?? '').trim();
  if (!trimmed || trimmed.length > MAX_CHARS) return false;
  const last = lastSentence(trimmed);
  if (!last || deliversInline(last)) return false;
  if (!PROMISE.test(last)) return false;

  /**
   * AN ANCHOR OUTSIDE THE PROMISE MEANS IT DELIVERED FIRST.
   *
   * "I found the bug at src/queue.ts:31. I will write that up next." is a real answer with a note
   * about what comes after — nudging it teaches the operator to ignore the nudge. But the anchor has
   * to be somewhere OTHER than the promise itself: in «Я создам файл в …/README.md.» the path is the
   * OBJECT of the promise, not evidence that anything was done. Testing the reply as a whole gets that
   * backwards, which is what the gate caught.
   */
  const before = trimmed.slice(0, trimmed.length - last.length);
  return !hasConcreteAnchor(before);
}

/**
 * ASK THE MODEL WHETHER THAT WAS REALLY THE END.
 *
 * The operator's design, and it is the right one: a phrase list catches the promises it was written
 * for, and the interesting failures are the ones nobody thought to add. So a turn that ends with no
 * tool call gets one small question — "is that it?" — and a `no` becomes a nudge.
 *
 * THE PROMPTS ARE FILES — `prompts/ayin/finishedCheck.txt` and `prompts/ayin/announcedNudge.txt`.
 * Repo rule, and the right one here: the wording of a nudge is exactly what an operator wants to tune
 * when it fires too often or not enough, and a template literal is invisible and needs a rebuild.
 *
 * IT IS PRE-FILTERED, HARD, and that is not an optimisation. Every turn in ayin ends without a tool
 * call eventually; asking on all of them would put a model call between the answer and the operator
 * seeing it, on the most latency-sensitive moment there is. So `worthAsking` throws out everything
 * that obviously delivered — a file:line, a code block, real length — and only the short, anchorless,
 * suspicious replies cost anything.
 *
 * A FAILED OR UNREADABLE ANSWER MEANS FINISHED. The check exists to catch a model that stopped early;
 * a judge that cannot answer must never be able to hold a finished turn open, because the cost of a
 * false "not done" is an infinite loop and the cost of a false "done" is one round the operator can
 * ask for themselves. Measured in Maradel: the same yes/no came back differently on two runs at
 * temperature 0, so this is asked once and never retried.
 */
export function worthAsking(text: string, didWork: boolean): boolean {
  if (didWork) return false;
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;                       // the empty-answer path owns this
  if (trimmed.length > MAX_CHARS) return false;     // long enough to be an answer
  if (/```/.test(trimmed)) return false;            // delivered code
  return !hasConcreteAnchor(trimmed);               // a path, a line, an identifier → it delivered
}

/** Anything that makes a reply a RESULT rather than an announcement. Mirrors `deferral.ts`. */
function hasConcreteAnchor(text: string): boolean {
  if (/\b[\w./-]+\.(?:ts|js|tsx|jsx|cs|py|go|rs|java|kt|rb|php|c|cpp|h|hpp|swift|sql|json|ya?ml|md)\b/i.test(text)) return true;
  if (/:\d+(?:-\d+)?\b/.test(text)) return true;
  if (/\bline\s+\d+/i.test(text)) return true;
  return false;
}

/**
 * Read the verdict. Anything that is not a clear "no" is a yes.
 *
 * Deliberately asymmetric: see `worthAsking`. A model that answers with a paragraph, an empty string,
 * or a refusal must not be able to hold the turn open.
 */
export function saysNotFinished(raw: string): boolean {
  const first = (raw ?? '').trim().toLowerCase().replace(/^[^\p{L}]+/u, '').split(/[^\p{L}]/u)[0] ?? '';
  return first === 'no' || first === 'нет' || first === 'ні';
}

/**
 * Did it stop short? The cheap gate, then — only if that is inconclusive — one small question.
 *
 * THE WHOLE DECISION LIVES HERE, not in the agent loop, for two reasons. The module that owns the
 * question should own asking it; and `agent.ts` must contain no `declareTools: false` — the loop is
 * the one caller that genuinely needs tools, and `check-gates.mjs` asserts exactly that. A yes/no
 * question wants prose back, so it declares none, and it does not belong in that file.
 *
 * `llmChat` is imported DYNAMICALLY so the pure half of this module stays importable without pulling
 * the provider stack in behind it — which is what lets `check-announced.mjs` test the detector with no
 * model, no network and no config.
 *
 * @param text     the final answer, marker already stripped
 * @param didWork  whether any tool ran this turn
 * @param request  what the operator actually asked — "is that it" is unanswerable without it
 */
export async function stoppedShort(text: string, didWork: boolean, request: string): Promise<boolean> {
  if (announcedWithoutActing(text, didWork)) return true;
  if (!worthAsking(text, didWork)) return false;

  try {
    const [{ llmChat }, { getPrompt }, { setLlmPurpose }] = await Promise.all([
      import('./llm/manager.js'),
      import('./prompts.js'),
      import('./timing.js'),
    ]);
    setLlmPurpose('finished-check');
    const verdict = await llmChat(
      [{ role: 'user', content: getPrompt('finishedCheck', { REQUEST: request.slice(0, 1200), REPLY: text.slice(0, 1200) }) }],
      { declareTools: false },
    );
    return saysNotFinished(verdict);
  } catch {
    // The check improves an answer that already exists; it never blocks one. See `saysNotFinished`.
    return false;
  }
}
