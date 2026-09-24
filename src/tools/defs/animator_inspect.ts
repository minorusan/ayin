import type { Tool } from '../base.js';
import { existsSync } from 'node:fs';
import { resolveAgainstCwd } from '../lib.js';
import { buildAnimatorMap, isAnimatorController } from '../../animator/map.js';
import { projectRootFor } from '../../prefab/edit.js';
import { resolveProject } from '../explore/index.js';

export const tool: Tool = {
    name: 'animator_inspect',
    icon: '🎬',
    description:
      'READ a Unity .controller as a map of states and transitions instead of raw YAML. Per transition: '
      + 'whether it has an EXIT TIME (without one it fires the moment its conditions hold, cutting the clip '
      + 'mid-play), whether the CLIPS OVERLAP and for how many seconds (a transition duration is normalized '
      + 'to the source clip unless it is fixed, so the arithmetic needs the clip length from another file), '
      + 'and its conditions spelled out ("isWinning is set"). Per state: its clip, that clip\'s length '
      + 'and loop flag, speed and whether it is the default. Read-only.',
    parameters: [
      { name: 'path', type: 'string', description: 'The .controller file. Absolute, or relative to the cwd.', required: true },
    ],
    async execute(params) {
      if (!params.path) return 'Error: path required';
      const abs = resolveAgainstCwd(params.path.trim());
      if (!existsSync(abs)) return `Error: file not found: ${abs}`;
      if (!isAnimatorController(abs)) {
        return `Error: ${abs} is not a .controller. An AnimatorController lives only in that file type; use prefab_inspect for .prefab, .unity and .asset.`;
      }
      const root = projectRootFor(abs) || resolveProject(abs).root;
      const map = await buildAnimatorMap(abs, { root }) as { layers?: unknown[]; parameters?: unknown[] };
      /**
       * AN EMPTY ANSWER MUST SAY WHICH EMPTY IT IS.
       *
       * `{"parameters": [], "layers": [], "findings": []}` is 115 bytes that mean either "this
       * controller genuinely has no states" or "the parser did not understand this file", and the
       * reader cannot tell them apart without going to the raw YAML — which is the round trip this
       * tool exists to remove. Reported verbatim on PointingHand.controller.
       *
       * The distinction is not decidable from the parse (that is the whole problem), so the note does
       * not claim one: it names both readings and the one command that settles it.
       */
      if ((map.layers?.length ?? 0) === 0) {
        return JSON.stringify({
          ...map,
          note: 'No layers parsed. Either this controller really is empty — a fresh asset, or an override '
            + 'controller whose states live in its parent — or its layout is one this reader does not '
            + 'handle. `read_file` on the .controller settles it: a real state machine has '
            + '`m_AnimatorStateMachine` blocks in the YAML.',
        }, null, 2);
      }
      return JSON.stringify(map, null, 2);
    },
  };
