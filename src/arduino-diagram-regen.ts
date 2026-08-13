/**
 * Regenerating wiring diagrams for the sketches a change touched — core orchestration, not a tool.
 *
 * This lived in `tools/arduino-diagram.ts` and was the last thing making a tool import the QA layer
 * (`qa/probes.js`). It was never a tool function: nothing in the tool catalogue calls it. Its three
 * callers are the Presenter executor, the QA executor's `prepare()` and the agent loop's post-turn
 * gate — all core. Composing a probe with a tool run is core's job by definition, and the import was
 * upside down: `tools/` cannot become its own package while a tool reaches into the agent's QA layer.
 *
 * `skip` is how the Presenter and QA executors stay off each other's toes: whichever runs first reports
 * what it covered, so a single Arduino change never spends its one-LLM-call-per-sketch grounding twice
 * in the same turn. The QA executor additionally puts sketches whose diagram is already newer than the
 * sketch into `skip`, so a multi-pass gate does not redraw an unchanged circuit on every pass.
 */

import { probeArduinoProject, type ChangedFile } from './qa/probes.js';
import { ensureToolRuntime } from './tool-wiring.js';
import {
  isDiagramCurrent, runArduinoDiagram, type RegenerateDiagramResult,
} from './tools/arduino-diagram.js';

// Runs a tool, so it wires the tool runtime itself rather than depending on import order. Idempotent.
ensureToolRuntime();

export async function regenerateTouchedDiagrams(
  root: string,
  files: ChangedFile[],
  skip: Set<string> = new Set(),
): Promise<RegenerateDiagramResult | null> {
  const arduino = probeArduinoProject(files, root);
  if (!arduino.applies || arduino.sketches.length === 0) return null;
  const pending = arduino.sketches
    .map((s) => s.path)
    .filter((p) => !skip.has(p) && !isDiagramCurrent(p));
  if (pending.length === 0) return { results: [], regeneratedPaths: new Set() };

  const only = new Set(pending);
  const outcome = await runArduinoDiagram(root, { open: false, only });
  if (!outcome.ok) return { results: [], regeneratedPaths: new Set() };
  return { results: outcome.results, regeneratedPaths: only };
}
