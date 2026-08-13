import type { Tool } from '../base.js';
import { join } from 'node:path';
import { entangle, entangledTo, gateAdoption, nextBrief } from '../../entangle/index.js';

export const tool: Tool = {
    name: 'entangle',
    description:
      'Bind this session to a design diagram (a naama HTML page or a .puml), so that from now on every ' +
      'file you write is checked against it mechanically. Call this when the operator says the design is ' +
      'settled and implementation begins — the path is the diagram you have just been working on. ' +
      'AFTER THIS: a write that declares a type the design does not have, adds a public member the design ' +
      'does not list, or references something the file\'s assembly/package manifest does not permit, WILL ' +
      'NOT LAND and the turn stops. That is not a failure to route around by renaming, relocating or ' +
      'inlining — it means the design and your intent have diverged, and only the operator resolves that. ' +
      'Report the gap and the options and wait. YOU CANNOT UNBIND: releasing a design is the operator\'s ' +
      'decision, never a step in your own work. op=status reports the binding; op=adoption lists designed ' +
      'types nothing has implemented yet.',
    parameters: [
      { name: 'path', type: 'string', description: 'Path to the diagram (naama .html or .puml). Required unless op is given.', required: false },
      { name: 'op', type: 'string', description: 'next | status | adoption. Omit to bind a design.', required: false },
      { name: 'scope', type: 'string', description: 'Optional: the domain (assembly/package) you are implementing. Limits "what remains" to that unit, so you are not told about work you were not asked to do.', required: false },
    ],
    async execute(params) {
      const op = (params.op ?? '').trim().toLowerCase();
      // NO `off`. MEASURED, and it is the whole reason this branch exists: given `op=off` in the tool
      // surface, the model called it — "Good — I'm disentangled. Now let me implement the remaining
      // types" — and then wrote four types the design did not declare. It did not rename, relocate or
      // inline to evade the gate; it switched the gate off, because switching it off was a documented
      // affordance. An enforcement mechanism the enforced party can disable is decoration.
      //
      // The design file was already read-only for the same reason one level down. Unbinding is the
      // operator's, through the session, and is deliberately absent from every tool the model can reach.
      if (op === 'off') {
        return 'Refused: you cannot unbind a design. If the design and your work have diverged, that is '
          + 'the gap to report — state it, give the options, and let the operator decide. Releasing the '
          + 'binding is their call, not a step in your implementation.';
      }
      if (op === 'status') {
        const to = entangledTo();
        return to ? `Entangled to ${to}` : 'Not entangled.';
      }
      // Retrieval, not a dump: one type with its intent, which is what the loop needs to take a step.
      if (op === 'next') {
        if (!entangledTo()) return 'Not entangled.';
        const brief = nextBrief();
        return brief ?? 'Every designed type is implemented. Nothing remains.';
      }
      if (op === 'adoption') {
        const gaps = gateAdoption();
        if (!entangledTo()) return 'Not entangled.';
        if (gaps.length === 0) return 'Every designed type is implemented.';
        return `${gaps.length} designed type(s) not implemented:\n` + gaps.map((g) => `  - ${g.gap}`).join('\n');
      }
      if (!params.path) return 'Error: path required (or op=off|status|adoption)';
      try {
        const r = entangle(params.path, params.scope ?? '');
        return `Entangled to ${r.source} — ${r.types} designed types, ${r.edges} edges` +
          `${r.scope ? `, working in ${r.scope}` : ''}. ` +
          `Every write is now checked: undesigned types, undesigned public members, and references the ` +
          `file's own manifest forbids. The design file itself is read-only while entangled.`;
      } catch (err) {
        return `Error: could not load design from ${params.path}: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
