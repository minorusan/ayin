/**
 * Base QA executor — the gate's behaviour for every project type nobody else claims.
 *
 * It prepares nothing and probes nothing beyond what `qa/probes.ts` already gathers for every turn
 * (webview reachability, README freshness, markdown richness, code shape, third-party APIs). That is
 * exactly the pre-executor behaviour, kept identical on purpose: this refactor is about letting a
 * project type opt IN to more, never about changing what a Node repo already got.
 *
 * The one thing it does contribute is the README check — and it asks about SUBSTANCE, not existence.
 * `scaffold()` guarantees the file, so "is it there" can no longer fail; what can fail is a stub whose
 * TODO markers are still in it, which passes every existence check while documenting nothing.
 */

import type { ChangedFile } from '../../../qa/probes.js';
import { readmeSubstance } from '../../deliverables.js';
import type { ExecutorConfig, PrepareResult, ProbeFact, ProjectContext, QaExecutor } from '../../types.js';

const config: ExecutorConfig = {
  id: 'base', kind: 'qa', projectTypes: ['*'], priority: 0,
  description: 'Generic QA — the standing probes, plus a README substance fact.',
};

export const baseQaExecutor: QaExecutor = {
  config,

  async prepare(): Promise<PrepareResult> {
    return { produced: [], handled: new Set(), notes: [] };
  },

  async probe(ctx: ProjectContext): Promise<ProbeFact[]> {
    // Substance, not mere existence — `scaffold()` guarantees the file, so "is it there" is a question
    // that can no longer fail. See `readmeSubstance`.
    const rm = readmeSubstance(ctx.root);
    return [{ key: 'readme-substance', ok: rm.ok, detail: rm.detail, hard: true }];
  },

  criteria(): string[] {
    return [];
  },
};
