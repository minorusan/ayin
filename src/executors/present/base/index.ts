/**
 * Base present executor — Presenter's behaviour for every project type nobody else claims.
 *
 * It contributes no extra artifact lines, which is exactly what Presenter did before executors
 * existed: quote the goal, one sentence on what the reply satisfies, the file list. Nothing about a
 * generic project has an artifact that Presenter must regenerate to be accurate.
 */

import type { ExecutorConfig, PresentExecutor } from '../../types.js';

const config: ExecutorConfig = {
  id: 'base', kind: 'present', projectTypes: ['*'], priority: 0,
  description: 'Generic presentation — the file list, no project-specific artifacts.',
};

export const basePresentExecutor: PresentExecutor = {
  config,
  async artifacts(): Promise<{ lines: string[]; handled: Set<string> }> {
    return { lines: [], handled: new Set() };
  },
};
