import type { Tool } from '../base.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { entangle } from '../../entangle/index.js';
import {
  applyLine as applyNaamaLine, emptyDoc as emptyNaamaDoc, loadDoc as loadNaama,
  render as renderNaama, saveDoc as saveNaama, validate as validateNaama,
  naamahAvailable, renderDesign,
} from '../../naama/index.js';

export const tool: Tool = {
    name: 'naama',
    description:
      'Author a DESIGN DOCUMENT one fact per line — types, their members, what each member must do, the ' +
      'domains (assembly/package) that own them and what those may reference. Use this during the design ' +
      'conversation instead of hand-writing a diagram file: nothing is regenerated, so nothing is dropped, ' +
      'and a fact about an undeclared type is refused instead of landing somewhere harmless. ' +
      'ops: add (apply lines) · show (read it back) · check (what cannot be true) · render (draw it as a ' +
      'page you can open). ' +
      'The `lines` grammar, one per line, batch as many as you like:\n' +
      '  domain <name> refs=A,B|NONE [sealed]\n' +
      '  type <Name> : class|interface|struct|enum|abstract @ <domain>  [— what it is for]\n' +
      '  member <Type>.<signature>  — what it MUST DO\n' +
      '  private <Type>.<signature>\n' +
      '  edge <From> -> <To> : dependency|extension|composition|aggregation\n' +
      '  drop type <Name> | drop domain <name>\n' +
      'Record the INTENT on every member — a signature alone cannot tell an implementer that a multiplier ' +
      'is the maximum of live values rather than their product, and that is the half a diagram loses.',
    parameters: [
      { name: 'path', type: 'string', description: 'The design file (.puml). Created on first add. This is the same file `naamah weave` renders and `entangle` enforces.', required: true },
      { name: 'op', type: 'string', description: 'add | show | export | check. Default add.', required: false },
      { name: 'lines', type: 'string', description: 'For add: one fact per line, in the grammar above.', required: false },
    ],
    async execute(params) {
      const op = (params.op ?? 'add').trim().toLowerCase();
      if (!params.path) return 'Error: path required';
      const doc = existsSync(params.path) ? loadNaama(params.path) : emptyNaamaDoc('');
      if (op === 'show') return renderNaama(doc);
      if (op === 'render') {
        return renderDesign(params.path);
      }
      if (op === 'check') {
        const problems = validateNaama(doc);
        return problems.length === 0
          ? 'No contradictions. Every type has a domain, every edge names known types, and no member ' +
            'reaches across a boundary its domain forbids.'
          : `${problems.length} problem(s) — each one would become a STOP at implementation time:\n` +
            problems.map((x) => `  - ${x}`).join('\n');
      }
      if (!params.lines) return 'Error: lines required for add';
      const results: string[] = [];
      const errors: string[] = [];
      for (const line of params.lines.split('\n')) {
        try {
          const r = applyNaamaLine(doc, line);
          if (r) results.push(`  ok   ${r}`);
        } catch (err) {
          errors.push(`  FAIL ${line.trim()} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      saveNaama(params.path, doc);
      // Partial application is deliberate: the good lines land and the bad ones are named, so a batch of
      // thirty facts is not lost because line nineteen had a typo.
      const tail = `\n${doc.domains.length} domain(s) · ${doc.types.length} type(s) · ` +
        `${doc.types.reduce((n, t) => n + t.members.length, 0)} member(s) · ${doc.edges.length} edge(s)`;
      return [...results, ...errors].join('\n') + tail;
    },
  };
