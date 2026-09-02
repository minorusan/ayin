/**
 * classify.ts — asking a model which kind of project a request describes, and only when nothing
 * cheaper can answer.
 *
 * THE BUG THIS EXISTS FOR, in one word: **"nodets"**.
 *
 *     Set me up a nodets project here! I want a nodets endpoint that serves a website…
 *
 * Every request pattern in `detect.ts` missed it. `\bnode\b` does not match `nodets`; `\bts\b` does
 * not either; `\bweb\b` does not match `website`. So the type came back `unknown`, which makes
 * `greenfield` false, which meant: the `base` executor instead of `node`, a scaffold of one README
 * instead of a whole project, no short-circuit (there was nothing on disk to satisfy), and two
 * `explore` calls over an empty directory because the greenfield skip is also keyed on that flag.
 * Every confusing thing in that transcript followed from one word not matching a regex.
 *
 * Regexes are the right first answer — they are free, and they get the common phrasings. They are the
 * wrong LAST answer, because the set of ways a person can name a stack is not enumerable, and each
 * miss degrades silently into "unknown" rather than into a question. So: patterns first, and when the
 * directory is EMPTY and they still have no answer, one short call to settle it.
 *
 * ONLY ON AN EMPTY DIRECTORY. Where files exist, the tree itself is the evidence and it is better
 * evidence than any request — `detect.ts` reads it and needs no help. This is for the one case where
 * there is nothing to read, which is precisely the turn that creates the project.
 */

import { llmChat } from '../llm/manager.js';
import { log } from '../log.js';
import { prompts, packagePath } from '../prompts-service.js';
import type { ProjectType } from './types.js';

/** Registered here as well as by the scaffold tool — `register` is idempotent and returns one bundle. */
const scaffoldPrompts = prompts.register('scaffold', packagePath('prompts', 'scaffold')).bundle;

export const CLASSIFIABLE: ProjectType[] = ['python', 'node', 'unity'];

/**
 * Which project type does this request describe, or null when it describes none of them.
 *
 * Null is a real answer and is returned rather than guessed past: "fix the typo in the README" is not
 * a new project, and inventing one for it would scaffold a manifest into somebody's turn.
 */
/**
 * Does this request ask for anything beyond the empty project the scaffold just made?
 *
 * THE BUG THIS EXISTS FOR. Plan mode skips planning when the scaffold has satisfied every REQUIRED
 * deliverable — which saved 8m51s on "set up an empty typescript web ui project" and was correct
 * there. It then fired on:
 *
 *     Set me up a nodets project here! I want a nodets endpoint that serves a website with ping pong
 *     game! One player plays with wasd other with arrows!
 *
 * Every required deliverable existed — `package.json`, `tsconfig.json`, `src/index.ts`,
 * `test/*.test.ts`, `.gitignore`, `README.md` — because those are what a PROJECT needs, and none of
 * them is a ping pong game. So the agent was handed grounding instead of a plan for a request that
 * badly needed one, and spent 25 minutes without one before the timeout took it.
 *
 * "Every deliverable exists" and "the request is done" are different questions, and only the second
 * one is the one being asked. The deliverables cannot answer it: they describe the shape of a project,
 * never the behaviour someone wanted. So this asks, in one short call, on the only turn where the
 * answer could save minutes.
 *
 * DEFAULTS TO "YES, THERE IS MORE" on any failure. Planning a request that needed no plan costs a
 * couple of minutes; skipping the plan for a request that needed one cost twenty-five.
 */
export async function requestNeedsMoreThanScaffold(request: string): Promise<boolean> {
  const text = request.trim();
  if (!text) return false;
  try {
    const raw = (await llmChat(
      [{ role: 'user', content: scaffoldPrompts.get('satisfied', { REQUEST: text.slice(0, 2000) }) }],
      { declareTools: false },
    )).trim().toLowerCase();
    const more = !/^\W*no\b/.test(raw);
    log('INFO', 'scaffold_satisfies_request', { answer: raw.slice(0, 30), needsMore: String(more) });
    return more;
  } catch (err) {
    log('WARN', 'scaffold_satisfies_failed', { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}

export async function classifyProjectType(about: string): Promise<ProjectType | null> {
  const request = about.trim();
  if (!request) return null;
  try {
    const raw = (await llmChat(
      [{ role: 'user', content: scaffoldPrompts.get('classify', { REQUEST: request.slice(0, 2000) }) }],
      { declareTools: false },
    )).trim().toLowerCase();
    const picked = CLASSIFIABLE.find((k) => raw.includes(k)) ?? null;
    log('INFO', 'project_type_classified', { request: request.slice(0, 80), answer: raw.slice(0, 40), picked: picked ?? 'none' });
    return picked;
  } catch (err) {
    // A classifier that cannot answer must not take the turn down with it: the caller falls back to
    // `unknown`, which is exactly where it was before this existed.
    log('WARN', 'project_type_classify_failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
