/**
 * Loading a design. Two formats, one normalized model.
 *
 * A naama HTML page carries its graph as a `<script id="graph" type="application/json">` payload —
 * clusters, nodes with member rows, typed edges — which is the richer source and the one to prefer.
 * PlantUML is the fallback, because a `.puml` is what exists before the page is rendered and what most
 * people already have.
 *
 * Both are parsed for DECLARATIONS only. Geometry is ignored; a diagram's coordinates are for the human.
 */

import { readFileSync } from 'node:fs';
import { parsePuml } from '../naama/index.js';
import type { Design, DesignedType, TypeKind } from './types.js';

const PUML_KIND: Record<string, TypeKind> = {
  class: 'class', interface: 'interface', enum: 'enum', struct: 'struct', 'abstract class': 'abstract',
};

/** `+Foo(...)`, `+event Bar`, `- _x : int` → the member's name. */
function memberName(row: string): string | null {
  const m = /^[+\-#~]?\s*(?:event\s+)?([A-Za-z_$][A-Za-z0-9_$]*)/.exec(row.trim());
  return m ? m[1] : null;
}

export function loadDesign(path: string): Design {
  const raw = readFileSync(path, 'utf-8');
  const graph = /<script id="graph" type="application\/json">([\s\S]*?)<\/script>/.exec(raw);
  return graph ? fromNaama(path, graph[1]) : fromPuml(path, raw);
}

/** The naama graph payload. */
function fromNaama(source: string, json: string): Design {
  const g = JSON.parse(json) as {
    clusters?: Array<{ id: string; label: string }>;
    nodes?: Array<{ id: string; kind: string; name: string; qname?: string; rows?: Array<{ kind: string; text: string }> }>;
    edges?: Array<{ from: string; to: string; type: string }>;
  };
  const types = new Map<string, DesignedType>();
  const id2name = new Map<string, string>();
  for (const c of g.clusters ?? []) id2name.set(c.id, c.label);
  for (const n of g.nodes ?? []) {
    if (n.kind === 'note') continue;
    id2name.set(n.id, n.name);
    const members: string[] = [];
    for (const r of n.rows ?? []) {
      if (r.kind === 'lede') continue; // prose, not a member
      const nm = memberName(r.text);
      if (nm) members.push(nm);
    }
    types.set(n.name, {
      name: n.name,
      kind: (PUML_KIND[n.kind] ?? (n.kind as TypeKind)),
      // qname is `<cluster>.<Type>`; the cluster half is where the diagram places it.
      domain: (n.qname ?? '').split('.').slice(0, 1).join('').trim(),
      members,
      spec: (n.rows ?? []).filter((r) => r.kind !== 'lede').map((r) => ({ sig: r.text })),
    });
  }
  const edges = (g.edges ?? []).map((e) => ({
    from: id2name.get(e.from) ?? e.from,
    to: id2name.get(e.to) ?? e.to,
    kind: e.type,
  }));
  return { source, types, edges };
}

/**
 * PlantUML, through naama's parser — the SAME one that writes it. Two parsers of one format diverge, and
 * the divergence surfaces as a design that enforces something subtly different from what was drawn.
 */
function fromPuml(source: string, src: string): Design {
  const doc = parsePuml(src);
  const types = new Map<string, DesignedType>();
  for (const t of doc.types) {
    types.set(t.name, {
      name: t.name,
      kind: t.kind,
      domain: t.domain,
      // Only the PUBLIC surface is a constraint; a `-private` row is the implementer's business.
      members: t.members.filter((m) => m.vis !== 'private').map((m) => memberName(m.sig) ?? m.sig).filter(Boolean),
      spec: t.members.map((m) => ({ sig: `${m.vis === 'private' ? '-' : '+'}${m.sig}`, ...(m.intent ? { intent: m.intent } : {}) })),
    });
  }
  return { source, types, edges: doc.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })) };
}
