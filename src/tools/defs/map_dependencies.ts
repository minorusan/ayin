import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Tool } from '../base.js';
import { toolLog, toolOpenInEditor, toolReport, toolWorkDir } from '../runtime.js';
import { buildDepMap, DEFAULT_DEPTH } from '../../depmap/index.js';
import { naamahAvailable, renderDesign, toPuml } from '../../naama/index.js';

/** `RewardService.cs, IRewardService.cs` and `["a.cs","b.cs"]` are both what a model sends. */
function splitPaths(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).map((s) => s.trim()).filter(Boolean);
    } catch { /* not JSON after all — fall through to the separator split */ }
  }
  return trimmed.split(/[,\n]/).map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

export const tool: Tool = {
  name: 'map_dependencies',
  icon: '🕸',
  description: '',
  parameters: [
    { name: 'files', type: 'string', description: 'The start file(s) — one path, or several separated by commas. All must be the same language.', required: true },
    { name: 'depth', type: 'string', description: `How many hops OUT from the start files to follow, default ${DEFAULT_DEPTH}. Base classes and interfaces ignore this and are always followed to the end.`, required: false },
    { name: 'render', type: 'string', description: 'Set to 0 to write the .puml without rendering the page.', required: false },
  ],
  async execute(params) {
    if (!params.files) return 'Error: files required — the path(s) to start from';
    const seeds = splitPaths(params.files);
    if (!seeds.length) return 'Error: files required — the path(s) to start from';

    const askedDepth = parseInt(params.depth ?? '', 10);
    let result;
    try {
      result = await buildDepMap(seeds, { depth: Number.isFinite(askedDepth) ? askedDepth : undefined });
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
    toolReport(`map_dependencies · ${result.language} · ${result.doc.types.length} type(s) across ${result.doc.domains.length} assembly(ies)`);

    const dir = toolWorkDir('diagrams');
    mkdirSync(dir, { recursive: true });
    const slug = seeds.map((s) => basename(s).replace(/\.[^.]+$/, '')).join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48) || 'depmap';
    const puml = join(dir, `${slug}-deps.puml`);
    writeFileSync(puml, toPuml(result.doc));

    let page = '';
    let rendered = '';
    if (params.render !== '0' && naamahAvailable()) {
      page = join(dir, `${slug}-deps.html`);
      rendered = await renderDesign(puml, page);
      if (/^Cannot render|^naamah failed/.test(rendered)) page = '';
    }
    const opened = page ? await toolOpenInEditor(page) : false;
    toolLog().info('depmap_built', {
      language: result.language, types: String(result.doc.types.length),
      edges: String(result.doc.edges.length), domains: String(result.doc.domains.length),
      depth: String(result.depth),
    });

    const lines = [
      `${result.doc.title}`,
      `${result.doc.types.length} type(s) · ${result.doc.edges.length} edge(s) · ${result.doc.domains.length} assembly(ies) · from ${result.seeds.join(', ')}`,
      '',
    ];
    for (const d of result.doc.domains) {
      const refs = d.references.length ? `references ${d.references.join(', ')}` : 'references NOTHING';
      const held = result.doc.types.filter((t) => t.domain === d.name).map((t) => t.name);
      lines.push(`  ${d.name} — ${refs}${d.sealed ? ' · no engine references' : ''}`);
      lines.push(`      ${held.join(', ')}`);
    }
    if (result.boundary.length) {
      lines.push('', `drawn but NOT expanded — the walk stopped at depth ${result.depth}: ${result.boundary.join(', ')}`,
        'Raise depth, or start again from one of these, to open them.');
    }
    if (result.ambiguous.length) {
      lines.push('', `AMBIGUOUS — more than one file declares these and the assembly did not settle it, so no edge was drawn: ${result.ambiguous.join(', ')}`);
    }
    if (result.capped) {
      lines.push('', 'The node cap stopped the walk: this graph is a SUBSET, not the whole picture. Lower depth or pick a narrower start file.');
    }
    lines.push('', `puml:  ${puml}`);
    lines.push(page ? `page:  ${page}${opened ? ' (opened)' : ''}` : 'page:  not rendered');
    lines.push('', 'Every type, member and assembly above was read from the files — nothing here was inferred.');
    return lines.join('\n');
  },
};
