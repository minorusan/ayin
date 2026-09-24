import type { Tool } from '../base.js';
import { existsSync } from 'node:fs';
import { resolveAgainstCwd } from '../lib.js';
import { buildPrefabMap, isInspectable } from '../../prefab/map.js';
import { renderPrefabTree, renderPrefabAt } from '../../prefab/render.js';
import { projectRootFor } from '../../prefab/edit.js';
import { resolveProject } from '../explore/index.js';

export const tool: Tool = {
    name: 'prefab_inspect',
    icon: '🔬',
    description:
      'READ a Unity .prefab, .unity scene or .asset as a STRUCTURED MAP instead of raw YAML. Called with just '
      + 'a path it returns the HIERARCHY: every GameObject, the components on each with their real class names, '
      + 'and every asset reference RESOLVED from its guid to what it points at ("TMP_FontAsset named '
      + 'Montserrat-SemiBold SDF.asset at Assets/TextMesh Pro/…"). Nested prefab instances are expanded with their '
      + 'overrides. THEN PASS `at` to open ONE node in full: at="GameOverLayer/Panel/RectTransform" prints every '
      + 'property of that RectTransform, at="GameOverLayer/Panel" prints that subtree. Read the hierarchy first, '
      + 'then ask for the node you want — do NOT dump the whole file with scalars=true to reach one component. '
      + 'Use this instead of read_file for any Unity asset: a prefab names nothing it depends on — every edge in '
      + 'it is a 32-hex guid — so reading the file text tells you the numbers and not the wiring. Read-only.',
    parameters: [
      { name: 'path', type: 'string', description: 'The .prefab, .unity or .asset file. Absolute, or relative to the cwd.', required: true },
      { name: 'at', type: 'string', description: 'A node inside the file, as a path of GameObject names ending in an optional component: "GameOverLayer/Panel/RectTransform" for that component\'s every property, "GameOverLayer/Panel" for that subtree. Omit it for the whole hierarchy.', required: false },
      { name: 'depth', type: 'string', description: 'How many nested-prefab levels to expand. Default 3, 0 keeps it to this file.', required: false },
      { name: 'format', type: 'string', description: 'tree (default — the hierarchy) or json (the full map, every property of every component; large).', required: false },
      { name: 'scalars', type: 'string', description: 'tree only: true also prints plain scalars on EVERY component. Prefer `at` — this is the whole file.', required: false },
      { name: 'properties', type: 'string', description: 'With `at` on a component: only these properties, comma-separated. Matched as substrings, so "fontSize" finds m_fontSize and m_fontSizeBase. Omit for all of them.', required: false },
    ],
    slash: {
      command: 'prefab',
      param: 'path',
      usage: '/prefab <path to .prefab|.unity|.asset> — the hierarchy, its components and what each reference points at',
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

      // `at` ANSWERS A QUESTION; the default answers "what is in here". It wins over `format` because
      // asking for one node and being handed the file is the behaviour this parameter exists to remove.
      if (params.at && params.at.trim()) {
        const only = String(params.properties ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        return renderPrefabAt(map, params.at.trim(), only);
      }

      /**
       * THE HIERARCHY IS THE DEFAULT, and JSON is what you ask for.
       *
       * It was the other way round: the agent got `JSON.stringify(map)` unless it said otherwise. On a
       * 45-object popup that is 2,586,026 characters over 45,310 lines — every property of every
       * component, most of them Unity bookkeeping, none of it readable and all of it clipped long before
       * it reached the model. The same file as a tree is 332 lines. A model that cannot see the shape
       * cannot ask for a part, so it reached for `scalars=true` and got 69,141 characters instead of
       * the four numbers it wanted. Shape first, then `at`.
       */
      if ((params.format ?? 'tree').toLowerCase() === 'json') return JSON.stringify(map, null, 2);
      return renderPrefabTree(map, { everything: params.scalars === 'true' });
    },
  };
