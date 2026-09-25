import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Tool } from '../base.js';
import { toolLog, toolOpenInEditor, toolReport, toolWorkDir } from '../runtime.js';
import { buildDepMap, DEFAULT_DEPTH } from '../../depmap/index.js';
import { writeDesign } from '../../depmap/design.js';
import { buildDesign, naamahAvailable } from '../../naama/index.js';

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
    { name: 'render', type: 'string', description: 'Set to 0 to write the design files without building the page.', required: false },
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

    /**
     * A DESIGN DIRECTORY, NOT A .puml. `naamah build` reads the design files straight, so the graph
     * ayin already has never passes through PlantUML — which also keeps the assembly name intact:
     * PlantUML nests a package on its dots, and `…Rewards.SolitaireStreak` and `…GameModes
     * .SolitaireStreak` both came out as a leaf box labelled "SolitaireStreak".
     */
    const dir = join(toolWorkDir('diagrams'), `${
      seeds.map((s) => basename(s).replace(/\.[^.]+$/, '')).join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48) || 'depmap'
    }-deps`);
    mkdirSync(dir, { recursive: true });
    const lang = result.language === 'csharp' ? 'cs' : 'ts';
    writeDesign(result.doc, dir, lang);

    let page = '';
    let built = '';
    if (params.render !== '0' && naamahAvailable()) {
      built = await buildDesign(dir);
      const candidate = join(dir, `${basename(dir)}.html`);
      if (!/^Cannot build|^naamah failed/.test(built) && existsSync(candidate)) page = candidate;
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
    /**
     * NAME THE REFERENCES THAT ARE ON THE PAGE, COUNT THE REST.
     *
     * `Core` declares forty-six, and printing all of them buried the eight types the walk actually
     * found under a paragraph of assembly names — reported as "a wall". The references worth reading
     * here are the ones this graph also drew, because those are the edges the picture explains; the
     * others are true and irrelevant to this question. The remainder is COUNTED rather than dropped,
     * since "references these two" and "references these two of forty-six" are different facts and
     * the second one is the one about coupling.
     */
    const drawn = new Set(result.doc.domains.map((d) => d.name));
    for (const d of result.doc.domains) {
      const here = d.references.filter((r) => drawn.has(r));
      const rest = d.references.length - here.length;
      const refs = d.references.length === 0 ? 'references NOTHING'
        : here.length === 0 ? `references ${d.references.length}, none of them drawn here`
          : `references ${here.join(', ')}${rest ? ` (+${rest} not on this graph)` : ''}`;
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
    lines.push('', `design: ${dir}/  (${result.doc.types.length} file(s), one per type)`);
    lines.push(page ? `page:   ${page}${opened ? ' (opened)' : ''}` : `page:   not built${built ? ` — ${built}` : ''}`);
    lines.push('', 'Every type, member and assembly above was read from the files — nothing here was inferred.');
    return lines.join('\n');
  },
};
