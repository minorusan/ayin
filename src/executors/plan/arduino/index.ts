/**
 * Arduino plan executor — what plan mode does when the project is (or is about to be) an Arduino one.
 *
 * IT REPLACES THE GENERIC SURVEY RATHER THAN ADDING TO IT, and that is the whole point. The generic
 * survey is not merely unhelpful on an embedded project, it is WRONG in a way that steers the work:
 * it reports "no HTTP server or dev server present — a webview needs something to serve it", "no
 * bundler and no existing HTML", "bind the server to all interfaces, not loopback, or the page will
 * be invisible from every other device" and "NO logging facility found — the plan must add one". A
 * planner reading that about a sketch that blinks an LED will dutifully write steps for problems the
 * project does not have. What an Arduino plan needs instead is the board, the toolchain, the sketch
 * naming rule, which pins can do PWM, and Serial Monitor as the observability story.
 *
 * GREENFIELD IS THE IMPORTANT CASE. `ctx.greenfield` is true when there is no sketch on disk yet and
 * the type came from the request — i.e. exactly the "create an Arduino project that…" turn, which is
 * the turn where grounding matters most and where every previous `isArduinoProject(root)` check said
 * "not Arduino" and withheld it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { prompts, packagePath } from '../../../prompts-service.js';
import { retrieveCatalog } from '../../../tools/arduino-db.js';
import { findSketches } from '../../../tools/arduino-explain.js';
import { boardFromFqbn, projectFqbn, pwmPins } from '../../../tools/arduino-toolchain.js';
import type { Deliverable, ExecutorConfig, PlanExecutor, ProjectContext } from '../../types.js';
import { ensureReadme } from '../base/index.js';

const arduinoPrompts = prompts.register('arduino', packagePath('prompts', 'arduino')).bundle;

const config: ExecutorConfig = {
  id: 'arduino', kind: 'plan', projectTypes: ['arduino'], priority: 100,
  description: 'Arduino planning — component catalog grounding, toolchain survey, Serial-Monitor observability.',
};

/** `#include <X.h>` across the sketches — what the plan must account for installing. */
function includedLibraries(root: string): string[] {
  const libs = new Set<string>();
  for (const s of findSketches(root)) {
    try {
      for (const m of readFileSync(s.path, 'utf8').matchAll(/^\s*#include\s*[<"]([A-Za-z0-9_.\/-]+)[>"]/gm)) {
        // Core headers ship with the toolchain; only third-party ones are a dependency to plan for.
        if (!/^(Arduino|stdint|string|math|stdlib|stdio|avr\/)/i.test(m[1])) libs.add(m[1]);
      }
    } catch { /* unreadable sketch — the survey says what it can */ }
  }
  return [...libs].sort();
}

/** Sketch folders whose main file is misnamed — a build-breaking fact the plan must open with. */
function namingViolations(root: string): string[] {
  return findSketches(root)
    .filter((s) => basename(s.path) !== `${basename(s.dir)}${s.path.slice(s.path.lastIndexOf('.'))}`)
    .map((s) => `${basename(s.path)} in ${basename(s.dir)}/ must be renamed to ${basename(s.dir)}${s.path.slice(s.path.lastIndexOf('.'))}`);
}

/** Directory entries at the root, so a greenfield plan can say plainly that it is starting from nothing. */
function rootEntries(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((e) => !e.startsWith('.'))
      .filter((e) => { try { return statSync(join(root, e)).isFile() || statSync(join(root, e)).isDirectory(); } catch { return false; } })
      .slice(0, 20);
  } catch { return []; }
}

export const arduinoPlanExecutor: PlanExecutor = {
  config,

  survey(ctx: ProjectContext): string {
    const { fqbn, source } = projectFqbn(ctx.root);
    const board = boardFromFqbn(fqbn);
    const sketches = findSketches(ctx.root);
    const libs = includedLibraries(ctx.root);
    const violations = namingViolations(ctx.root);
    const entries = rootEntries(ctx.root);

    const lines = [
      `Project root: ${ctx.root}`,
      'Type: Arduino sketch project',
      `Detected from: ${ctx.evidence}${ctx.greenfield ? ' — NOTHING IS ON DISK YET; this plan creates the project' : ''}`,
      `Target board (FQBN): ${fqbn} (from ${source}) → board family "${board}"`,
      `PWM-capable pins on this board: ${pwmPins(board).join(', ') || 'unknown for this board — check its datasheet before using analogWrite'}`,
      '',
      'SKETCHES:',
      ...(sketches.length
        ? sketches.map((s) => `  - ${s.dir.replace(ctx.root, '.')}/${basename(s.path)} (folder "${basename(s.dir)}")`)
        : ['  - none yet']),
      violations.length ? `  ! SKETCH NAMING VIOLATED: ${violations.join('; ')}` : '',
      '',
      `THIRD-PARTY LIBRARIES INCLUDED: ${libs.length ? libs.join(', ') : 'none'}`,
      `README: ${existsSync(join(ctx.root, 'README.md')) ? 'present' : 'MISSING — ayin creates a stub at project start; fill it in'}`,
      entries.length ? `Existing entries at root: ${entries.join(', ')}` : 'Root is empty.',
      '',
      'VERIFICATION COMMANDS (this is what "it works" means without hardware attached):',
      `  - arduino-cli compile --fqbn ${fqbn} <sketch-folder>`,
      `  - arduino-cli upload -p <port> --fqbn ${fqbn} <sketch-folder>   (only with a board attached)`,
      '  - arduino-cli monitor -p <port>                                  (reads Serial output)',
      '',
      'THERE IS NO WEBVIEW, NO HTTP SERVER, NO BUNDLER AND NO LOGGER MODULE IN THIS PROJECT, and none',
      'of those is a gap to close — this is firmware. Do not plan work to add them. The equivalents',
      'are Serial Monitor, the built-in LED, and the wiring diagram; see the observability section.',
    ];
    return lines.filter((l) => l !== '').join('\n');
  },

  /**
   * `request` is the retrieval query. Dumping all 28 components cost 10,196 characters on every
   * plan for a project that uses four — ~24 distractors, which is the specific thing measured to
   * degrade a model's instruction-following. Retrieved, the same block is 2.0–3.5k and the parts
   * that matter are at the top. See `retrieveCatalog`.
   */
  grounding(ctx: ProjectContext, request = ''): string {
    return arduinoPrompts.get('planGrounding', {
      GREENFIELD_NOTE: ctx.greenfield
        ? ' — nothing on disk yet, so this plan decides the folder name, the sketch name and the wiring'
        : '',
      CATALOG: retrieveCatalog(request || ctx.evidence).text,
    });
  },

  // Each deliverable carries BOTH depths on purpose: the operator may be standing in the project
  // folder that contains the sketch folder, or inside the sketch folder itself. Both are the same
  // correct project — see `Deliverable.patterns`.
  deliverables(): Deliverable[] {
    return [
      {
        label: 'the sketch',
        patterns: ['*/*.ino', '*.ino', '*/*.pde', '*.pde'],
        why: 'the program itself, in a folder whose name it matches exactly — the toolchain refuses to build anything else',
        required: true,
      },
      {
        label: 'README',
        patterns: ['README.md'],
        // NAMES THE PATH, and says not to make a second one. `scaffold()` has already created
        // README.md at the project ROOT as a stub; a generic "write a README" instruction led one
        // project to write `TrafficLight/README.md` instead, leaving the root file sitting there with
        // its TODO markers intact — so the project both was and was not documented, and the file a
        // person opens first said TODO.
        // Every clause here is CHECKED by `readmeSubstance()`, not merely requested. The two that are
        // named last were each a coin flip until the gate enforced them.
        why: 'README.md AT THE PROJECT ROOT — already created as a stub, so fill THAT file in rather than creating another one elsewhere. It must contain: what the circuit does, the parts list, a PIN MAP naming every pin the code drives, and the exact `arduino-cli compile` and `upload` commands. A README without the pin map or the build commands is rejected.',
        required: true,
      },
      {
        label: 'the wiring diagram',
        patterns: ['*/*.wiring.puml', '*.wiring.puml'],
        why: 'wiring is shown, never narrated — a validated PlantUML source generated from the sketch\'s real pin usage by the arduino_diagram tool',
        required: true,
      },
      {
        label: 'the rendered diagram',
        patterns: ['*/*.wiring.svg', '*.wiring.svg'],
        why: 'the diagram as an editable vector anyone can open without PlantUML installed',
        required: true,
      },
    ];
  },

  observability(ctx: ProjectContext): string {
    return arduinoPrompts.get('planObservability', { FQBN: projectFqbn(ctx.root).fqbn });
  },

  scaffold(ctx: ProjectContext): string[] {
    // Same deterministic README the base executor writes — an Arduino project needs one at least as
    // much as any other, since the parts list and the pin map have nowhere else to live.
    return ensureReadme(ctx.root);
  },
};
