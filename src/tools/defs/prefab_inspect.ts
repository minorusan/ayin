import type { Tool } from '../base.js';
import { existsSync } from 'node:fs';
import { resolveAgainstCwd } from '../lib.js';
import { buildPrefabMap, isInspectable } from '../../prefab/map.js';
import { renderPrefabTree } from '../../prefab/render.js';
import { projectRootFor } from '../../prefab/edit.js';
import { resolveProject } from '../explore/index.js';

export const tool: Tool = {
    name: 'prefab_inspect',
    icon: '🔬',
    description:
      'READ a Unity .prefab, .unity scene or .asset as a STRUCTURED MAP instead of raw YAML: the GameObject '
      + 'hierarchy, the components on each object with their real class names, every property, and every asset '
      + 'reference RESOLVED from its guid to what it actually points at ("TMP_FontAsset named Montserrat-SemiBold '
      + 'SDF.asset at Assets/TextMesh Pro/…"). Nested prefab instances are expanded with their overrides. Use this '
      + 'instead of read_file for any Unity asset: a prefab names nothing it depends on — every edge in it is a '
      + '32-hex guid — so reading the file text tells you the numbers and not the wiring. Read-only.',
    parameters: [
      { name: 'path', type: 'string', description: 'The .prefab, .unity or .asset file. Absolute, or relative to the cwd.', required: true },
      { name: 'depth', type: 'string', description: 'How many nested-prefab levels to expand. Default 3, 0 keeps it to this file.', required: false },
      { name: 'format', type: 'string', description: 'json (default — the full map) or tree (a readable hierarchy).', required: false },
      { name: 'scalars', type: 'string', description: 'tree only: true also prints plain scalar properties, not just references.', required: false },
    ],
    slash: {
      command: 'prefab',
      param: 'path',
      usage: '/prefab <path to .prefab|.unity|.asset> — the hierarchy, its components and what each reference points at',
      // The operator gets the readable tree in a pager; the agent, calling the same tool, gets JSON.
      defaults: { format: 'tree' },
      overlay: true,
    },
    async execute(params) {
      if (!params.path) return 'Error: path required';
      const abs = resolveAgainstCwd(params.path.trim());
      if (!existsSync(abs)) return `Error: file not found: ${abs}`;
      if (!isInspectable(abs)) {
        return `Error: ${abs} is not a .prefab, .unity or .asset. Those three share Unity's YAML dialect; anything else is a different format.`;
      }
      // The project root decides where guids are looked up, so a wrong root means every reference reads as
      // missing. Unity's own markers first, then explore's walk-up as the fallback.
      const root = projectRootFor(abs) || resolveProject(abs).root;
      const depth = params.depth === undefined ? 3 : Math.max(0, Math.min(8, Number(params.depth) || 0));
      const map = await buildPrefabMap(abs, { root, depth });

      if ((params.format ?? 'json').toLowerCase() === 'tree') {
        return renderPrefabTree(map, { everything: params.scalars === 'true' });
      }
      return JSON.stringify(map, null, 2);
    },
  };
