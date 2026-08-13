/**
 * Arduino present executor — the artifact lines an Arduino presentation owes the user.
 *
 * A presentation of Arduino work is only accurate if the wiring diagram it can point at is CURRENT,
 * so this regenerates the diagram for the sketches the turn touched and then names the resulting
 * paths. That is the same `regenerateTouchedDiagrams` the QA executor's `prepare()` calls, sharing
 * the same skip set — one grounding LLM call per sketch per turn, never two, whichever of the two
 * gates happens to run first.
 *
 * It also states the deliverable set plainly. "Here is what changed" is only half of what the user
 * asked for on an Arduino project; the other half is "and here is the sketch, the README and the
 * diagram, which is what a finished project looks like on disk".
 */

import { log } from '../../../log.js';
import { regenerateTouchedDiagrams } from '../../../arduino-diagram-regen.js';
import type { ChangedFile } from '../../../qa/probes.js';
import { checkDeliverables } from '../../deliverables.js';
import { arduinoPlanExecutor } from '../../plan/arduino/index.js';
import type { ExecutorConfig, PresentExecutor, ProjectContext } from '../../types.js';
import { ensureToolRuntime } from '../../../tool-wiring.js';

// Imports a tool implementation directly, so it wires the tool runtime itself rather than
// depending on whatever else the process happened to load first. Idempotent.
ensureToolRuntime();

const config: ExecutorConfig = {
  id: 'arduino', kind: 'present', projectTypes: ['arduino'], priority: 100,
  description: 'Arduino presentation — regenerates the wiring diagram and names the deliverable set.',
};

export const arduinoPresentExecutor: PresentExecutor = {
  config,

  async artifacts(ctx: ProjectContext, files: ChangedFile[], skip: Set<string>): Promise<{ lines: string[]; handled: Set<string> }> {
    const lines: string[] = [];
    let handled = new Set<string>();

    try {
      const regen = await regenerateTouchedDiagrams(ctx.root, files, skip);
      if (regen) {
        handled = regen.regeneratedPaths;
        for (const r of regen.results) {
          const target = r.svgPath ?? r.pumlPath;
          const health = r.svgPath
            ? (r.verified ? 'validated by plantuml' : 'rendered, but `plantuml -syntax` flagged it')
            : 'plantuml not installed — .puml written, not rendered';
          lines.push(`${target} — wiring diagram regenerated from the sketch's real pin usage (${r.connectionsMatched}/${r.pinsFound} pins matched to the component catalog, ${health})`);
        }
      }
    } catch (err) {
      log('WARN', 'arduino_present_regen_failed', { error: err instanceof Error ? err.message : String(err) });
    }

    const missing = checkDeliverables(ctx.root, arduinoPlanExecutor.deliverables(ctx))
      .filter((s) => !s.satisfied && s.deliverable.required);
    // Named in the presentation rather than hidden: a user reading "done" deserves to see, in the
    // same block, that the project is still missing something the project type requires.
    if (missing.length) {
      lines.push(`STILL MISSING: ${missing.map((m) => `${m.deliverable.label} (${m.deliverable.patterns[0]})`).join(', ')}`);
    }

    return { lines, handled };
  },
};
