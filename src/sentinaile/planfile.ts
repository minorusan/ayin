/**
 * `sentinaile_plan.md` — the artifact a human reads, edits, and trusts.
 *
 * THE FILE IS AUTHORITATIVE, not a rendering of state kept elsewhere. Each run reads it fresh and is
 * handed its contents, so editing the markdown changes what the next run does with no command to
 * re-issue and no re-planning call. That is the point of writing a plan down at all: if the file were
 * a read-only echo of a decision buried in JSON, an operator who disagreed with step 3 would have to
 * delete the sentinel and describe the whole thing again.
 *
 * It also means a sentinel can be reviewed before it ever runs. `/sentinaile` prints the path; the
 * plan sits there in plain markdown until the first run is due.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describeSchedule } from './schedule.js';
import type { PlanDraft, SentinelState } from './types.js';

/** Everything below this line is regenerated; everything above it is the operator's. */
const EDIT_NOTE = '<!-- Edit the steps freely: each run reads this file fresh. -->';

export function renderPlanFile(draft: PlanDraft, state: SentinelState, now: number): string {
  const lines: string[] = [];
  lines.push(`# ${draft.title}`);
  lines.push('');
  lines.push(EDIT_NOTE);
  lines.push('');
  lines.push(`**Requested:** ${state.request}`);
  lines.push('');
  lines.push(`**Schedule:** ${describeSchedule(state.schedule, now)}`);
  lines.push(`**Working directory:** ${state.cwd}`);
  lines.push(`**Sentinel id:** ${state.id}`);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  draft.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.instruction}`);
    if (s.rationale) lines.push(`   - _why:_ ${s.rationale}`);
  });
  lines.push('');
  lines.push('## Reporting');
  lines.push('');
  lines.push('Each run ends with a short report. A run that finds nothing wrong says so explicitly —');
  lines.push('silence and a broken watch look identical from outside.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function writePlanFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
}

/** The plan as the next run will see it. Null when the operator deleted the file. */
export function readPlanFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}
