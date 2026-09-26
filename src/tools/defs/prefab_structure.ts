import type { Tool } from '../base.js';
import { existsSync } from 'node:fs';
import { resolveAgainstCwd } from '../lib.js';
import { isInspectable } from '../../prefab/map.js';
import { projectRootFor } from '../../prefab/edit.js';
import { deleteFromPrefab, reparentInPrefab, type StructureRequest } from '../../prefab/structure.js';
import { toolLog } from '../runtime.js';

/**
 * `prefab_structure` — move or remove an object in a Unity asset, as opposed to changing one value.
 *
 * SEPARATE FROM `prefab_edit` ON PURPOSE. That tool writes one property and is safe because that is
 * all it can do; putting "delete this subtree" behind the same name would make every call to it a
 * heavier decision. Two names, two levels of care.
 */
export const tool: Tool = {
  name: 'prefab_structure',
  icon: '🧩',
  description: '',
  parameters: [
    { name: 'path', type: 'string', description: 'The .prefab, .unity or .asset file.', required: true },
    { name: 'op', type: 'string', description: 'reparent | delete', required: true },
    { name: 'object', type: 'string', description: 'The GameObject: a unique name, or #<fileID> when the name repeats.', required: true },
    { name: 'to', type: 'string', description: 'reparent: the new parent, by name or #<fileID>. Omit to move it to the file root.', required: false },
    { name: 'component', type: 'string', description: 'delete: a component class on `object` to remove instead of the object itself.', required: false },
    { name: 'dry_run', type: 'string', description: 'true shows the diff and writes nothing. Do this first.', required: false },
  ],
  async execute(params) {
    if (!params.path || !params.op || !params.object) return 'Error: path, op and object required';
    const abs = resolveAgainstCwd(params.path.trim());
    if (!existsSync(abs)) return `Error: file not found: ${abs}`;
    if (!isInspectable(abs)) return `Error: ${abs} is not a Unity serialized asset.`;
    const root = projectRootFor(abs);
    if (!root) return `Error: ${abs} is not inside a Unity project (no Assets/ above it).`;

    const req: StructureRequest = {
      file: abs, root,
      object: params.object.trim(),
      to: params.to?.trim(),
      component: params.component?.trim() || undefined,
      dryRun: /^(true|1|yes|on)$/i.test((params.dry_run ?? '').trim()),
    };
    const op = params.op.trim().toLowerCase();
    const result = op === 'reparent' ? reparentInPrefab(req)
      : op === 'delete' ? deleteFromPrefab(req)
        : { ok: false as const, error: `unknown op "${params.op}" — it is reparent or delete` };

    if (!result.ok) return `Refused: ${result.error}`;
    toolLog().info('prefab_structure_done', { op, dryRun: String(Boolean(req.dryRun)) });
    return result.dryRun
      ? `DRY RUN — nothing was written. This is what the write would do: ${result.what}.\n${result.diff}\n`
        + `Run again without dry_run to apply it.`
      : `${result.what}.\n${result.diff}`;
  },
};
