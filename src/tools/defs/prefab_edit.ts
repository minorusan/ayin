import type { Tool } from '../base.js';
import { existsSync } from 'node:fs';
import { resolveAgainstCwd } from '../lib.js';
import { isInspectable } from '../../prefab/map.js';
import { projectRootFor, setPrefabProperty } from '../../prefab/edit.js';
import { resolveProject } from '../explore/index.js';

export const tool: Tool = {
    name: 'prefab_edit',
    icon: '🧱',
    description:
      'Set ONE property in a Unity .prefab, .unity scene or .asset — surgically, so the file differs by one line. '
      + 'Point a reference at another asset BY FILE NAME (asset="Hero_SkeletonData.asset"): the name is '
      + 'resolved to its guid, and the existing fileID and type are kept so the reference stays valid. Or set a '
      + 'scalar (value="0.5"), including a field inside a vector (property="m_Pivot.x"). Address the target as '
      + 'object=<hierarchy path> and component=<class name>, both exactly as prefab_inspect prints them; '
      + 'component="#<fileID>" when two components share a class. It REFUSES an ambiguous name and a reference '
      + 'whose class does not match the field, rather than writing something Unity will read as null. '
      + 'Does NOT add or remove components or GameObjects — properties only.',
    parameters: [
      { name: 'path', type: 'string', description: 'The .prefab, .unity or .asset to change.', required: true },
      { name: 'property', type: 'string', description: 'The property name, e.g. m_SkeletonDataAsset, freeze, m_Pivot.x.', required: true },
      { name: 'object', type: 'string', description: 'The GameObject: a hierarchy path (Canvas/Progress/Slot0) or a unique name. Omit for a single-document .asset.', required: false },
      { name: 'component', type: 'string', description: 'The component class (SkeletonGraphic, RectTransform) or #<fileID>.', required: false },
      { name: 'value', type: 'string', description: 'A scalar, written as-is. Mutually exclusive with asset.', required: false },
      { name: 'asset', type: 'string', description: 'An asset FILE NAME to reference. Resolved to a guid; ambiguity is refused.', required: false },
    ],
    async execute(params) {
      if (!params.path || !params.property) return 'Error: path and property required';
      const abs = resolveAgainstCwd(params.path.trim());
      if (!existsSync(abs)) return `Error: file not found: ${abs}`;
      if (!isInspectable(abs)) return `Error: ${abs} is not a .prefab, .unity or .asset.`;
      const root = projectRootFor(abs) || resolveProject(abs).root;

      const result = await setPrefabProperty({
        file: abs, root,
        object: params.object?.trim() || undefined,
        component: params.component?.trim() || undefined,
        property: params.property.trim(),
        value: params.value,
        asset: params.asset?.trim() || undefined,
      });
      if (!result.ok) return `Refused: ${result.error}`;
      return `Set ${params.property} on ${result.target} — ${result.rule}.\n${result.diff}`;
    },
  };
