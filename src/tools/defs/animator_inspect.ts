import type { Tool } from '../base.js';
import { existsSync } from 'node:fs';
import { resolveAgainstCwd } from '../lib.js';
import { buildAnimatorMap, isAnimatorController } from '../../animator/map.js';
import { projectRootFor } from '../../prefab/edit.js';
import { resolveProject } from '../explore/index.js';

export const tool: Tool = {
    name: 'animator_inspect',
    icon: '▷',
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
      return JSON.stringify(await buildAnimatorMap(abs, { root }), null, 2);
    },
  };
