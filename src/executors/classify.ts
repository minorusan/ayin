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
