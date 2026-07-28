/**
 * diagram — "explain it with a picture": generate a VALIDATED PlantUML diagram, write it next to the
 * work, render it, and hand back the path.
 *
 * It is an agentic LOOP, not a single shot, because an LLM writing PlantUML gets the syntax wrong
 * often enough that a one-shot tool would mostly emit broken files:
 *
 *   1. ask the model for PlantUML source for <subject>
 *   2. strip prose/fences down to the @startuml…@enduml block
 *   3. VALIDATE with the real renderer — `plantuml -syntax` on stdin, which answers either
 *        ERROR / <line> / <message>          → feed that back verbatim and retry
 *        <TYPE> / (<n> participants)         → valid, and we learn what kind of diagram it built
 *   4. on success: write `<dir>/<slug>.puml`, render SVG, open it if an editor is available
 *
 * The validator is the ground truth, so the tool cannot report success on a file that will not
 * render. Rounds are capped; a diagram that will not converge returns the last error plus the
 * source, which is still more useful than nothing.
 *
 * PRIVACY. Nothing leaves the machine. PlantUML's public server would render these in one HTTP call,
 * but a diagram of your architecture is exactly the thing not to POST to a third party — so
 * rendering is LOCAL only, and a remote renderer is opt-in via AYIN_PUML_SERVER (point it at your
 * own PlantUML/Kroki instance). With no local `plantuml`, the file is still written and validated
 * structurally, and the tool says plainly that it could not fully verify it.
 *
 * SAFETY. `!include` / `!includeurl` / `!includesub` are stripped from generated source. PlantUML
 * resolves those at render time — reading local files or fetching URLs into the image — which is a
 * neat exfiltration path for anything that can influence the model's output.
 *
 * Env: AYIN_PUML_BIN (default `plantuml`) · AYIN_PUML_DIR (default cwd) · AYIN_PUML_RENDER
 * (svg|png|0, default svg) · AYIN_PUML_OPEN (auto|0, default auto) · AYIN_PUML_SERVER (opt-in).
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { llmChat } from '../llm/manager.js';
import { log } from '../log.js';
import { prompts, packagePath } from '../prompts-service.js';

/**
 * This tool's prompt namespace — `prompts/diagram/*.txt`, materialized into the operator's local
 * store at import time. INTERIM SHAPE: diagram is still a plain function, not a `BaseTool`, so it
 * registers here at module scope instead of declaring `promptsSourceDir` and being handed a bundle
 * by the registry. The namespace boundary is already correct; when diagram becomes a class the swap
 * is mechanical — `diagramPrompts.get(...)` → `this.prompt(...)`.
 */
const diagramPrompts = prompts.register('diagram', packagePath('prompts', 'diagram')).bundle;

const MAX_ROUNDS = 4;
const PUML_BIN = process.env.AYIN_PUML_BIN || 'plantuml';
const RENDER = (process.env.AYIN_PUML_RENDER ?? 'svg').toLowerCase(); // svg | png | 0
const OPEN_MODE = (process.env.AYIN_PUML_OPEN ?? 'auto').toLowerCase(); // auto | 0

export interface DiagramResult {
  ok: boolean;
  /** Absolute path of the written .puml (written even when validation failed). */
  file?: string;
  /** Rendered image, when a local renderer produced one. */
  image?: string;
  /** What PlantUML says it is: SEQUENCE, CLASS, ACTIVITY, STATE, … */
  kind?: string;
  summary?: string;
  rounds: number;
  error?: string;
  source: string;
  /** Whether an editor was actually opened (vs. the file just being left in place). */
  opened: boolean;
  /** True when no renderer was available and only a structural check ran. */
  unverified?: boolean;
}

function run(cmd: string, args: string[], stdin?: string, timeoutMs = 25_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
    if (stdin !== undefined) { child.stdin?.end(stdin); }
  });
}

let _hasPuml: boolean | null = null;
async function hasPlantuml(): Promise<boolean> {
  if (_hasPuml !== null) return _hasPuml;
  const { code } = await run(PUML_BIN, ['-version'], undefined, 15_000);
  _hasPuml = code === 0;
  return _hasPuml;
}

/** Pull the diagram out of whatever the model wrapped it in (fences, preamble, apologies). */
export function extractPuml(raw: string): string {
  const fenced = raw.match(/```(?:plantuml|puml|uml)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.search(/@start(uml|mindmap|wbs|gantt|json|yaml|salt)/i);
  if (start < 0) return '';
  const endMatch = body.slice(start).match(/@end(uml|mindmap|wbs|gantt|json|yaml|salt)/i);
  if (!endMatch || endMatch.index === undefined) return '';
  return body.slice(start, start + endMatch.index + endMatch[0].length).trim();
}

/** Strip include directives — see SAFETY in the header. Returns the source and what was removed. */
function stripIncludes(src: string): { src: string; stripped: string[] } {
  const stripped: string[] = [];
  const out = src
    .split('\n')
    .filter((l) => {
      if (/^\s*!include(url|sub)?\b/i.test(l)) { stripped.push(l.trim()); return false; }
      return true;
    })
    .join('\n');
  return { src: out, stripped };
}

/**
 * Validate with the real renderer. `plantuml -syntax` reads stdin and prints either
 * `ERROR\n<line>\n<message>` or `<TYPE>\n<summary>` — no temp file, no image, no network.
 */
async function validate(src: string): Promise<{ ok: boolean; kind?: string; summary?: string; error?: string; unverified?: boolean }> {
  if (!(await hasPlantuml())) {
    // Structural check only — honest about being weaker than the renderer.
    const balanced = /@start\w+/i.test(src) && /@end\w+/i.test(src);
    const hasBody = src.split('\n').filter((l) => l.trim() && !/^@|^'/.test(l.trim())).length > 0;
    return balanced && hasBody
      ? { ok: true, unverified: true }
      : { ok: false, error: 'structural check failed: missing @start/@end or empty body', unverified: true };
  }
  const { out } = await run(PUML_BIN, ['-syntax'], src);
  const lines = out.split('\n').map((l) => l.trim());
  if (lines[0]?.toUpperCase() === 'ERROR') {
    const line = lines[1] ?? '?';
    const msg = lines.slice(2).filter(Boolean).join(' — ') || 'syntax error';
    return { ok: false, error: `line ${line}: ${msg}` };
  }
  return { ok: true, kind: lines[0] || undefined, summary: lines[1] || undefined };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'diagram';
}

/**
 * The loop. `context` is optional grounding (facts the agent already gathered) — passing it makes
 * the difference between a generic picture and one that names your actual modules.
 */
export async function makeDiagram(subject: string, opts: { kind?: string; context?: string; dir?: string; open?: boolean } = {}): Promise<DiagramResult> {
  const dir = opts.dir || process.env.AYIN_PUML_DIR || process.cwd();
  let source = '';
  let lastError = '';

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const repair = lastError
      ? `\n\n${diagramPrompts.get('repair', { ERROR: lastError, SOURCE: source })}`
      : '';
    // Data-carrying vars go in LAST: `interpolate` rescans the whole string per key, so an
    // earlier-inserted value holding a later `{{VAR}}` would be expanded. REPAIR carries the
    // model's own previous output — the least trustworthy blob — so it is substituted last.
    const prompt = diagramPrompts.get('draw', {
      KIND: opts.kind ? `${opts.kind} ` : '',
      SUBJECT: subject,
      CONTEXT_BLOCK: opts.context
        ? diagramPrompts.get('groundingContext', { CONTEXT: opts.context })
        : '',
      REPAIR: repair,
    });

    let raw: string;
    try {
      raw = await llmChat([{ role: 'user', content: prompt }]);
    } catch (err) {
      return { ok: false, rounds: round, error: `model call failed: ${err instanceof Error ? err.message : String(err)}`, source, opened: false };
    }

    const extracted = extractPuml(raw);
    if (!extracted) { lastError = diagramPrompts.get('noBlockError'); continue; }
    const { src, stripped } = stripIncludes(extracted);
    source = src;
    if (stripped.length) log('WARN', 'diagram_include_stripped', { count: String(stripped.length) });

    const v = await validate(source);
    if (!v.ok) { lastError = v.error ?? 'unknown validation error'; log('INFO', 'diagram_repair', { round: String(round), error: lastError.slice(0, 120) }); continue; }

    // ── valid: write, render, open ───────────────────────────────────
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${slugify(subject)}.puml`);
    writeFileSync(file, `${source}\n`);

    let image: string | undefined;
    if (RENDER !== '0' && (await hasPlantuml())) {
      const flag = RENDER === 'png' ? '-tpng' : '-tsvg';
      const { code } = await run(PUML_BIN, [flag, file], undefined, 60_000);
      const candidate = file.replace(/\.puml$/, RENDER === 'png' ? '.png' : '.svg');
      if (code === 0 && existsSync(candidate)) image = candidate;
    }

    const opened = opts.open === false || OPEN_MODE === '0' ? false : await openInEditor(image ?? file);
    log('INFO', 'diagram_made', { file, kind: v.kind ?? '?', rounds: String(round) });
    return { ok: true, file, image, kind: v.kind, summary: v.summary, rounds: round, source, opened, unverified: v.unverified };
  }

  // Out of rounds — still write it down. A broken draft beats an invisible one.
  let file: string | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${slugify(subject)}.invalid.puml`);
    writeFileSync(file, `' VALIDATION FAILED: ${lastError}\n${source}\n`);
  } catch { /* nowhere to write — the source is still in the result */ }
  return { ok: false, rounds: MAX_ROUNDS, error: lastError, source, file, opened: false };
}

/** Open in VS Code if its CLI is on PATH; otherwise leave the file and say so. */
async function openInEditor(target: string): Promise<boolean> {
  for (const bin of ['code', 'code-insiders', 'codium']) {
    const { code } = await run(bin, ['--version'], undefined, 8_000);
    if (code === 0) {
      const r = await run(bin, [target], undefined, 10_000);
      return r.code === 0;
    }
  }
  return false;
}

/** Tool entry point: `diagram(subject=…, kind=…, context=…)`. */
export async function diagramExecute(params: Record<string, string>): Promise<string> {
  const subject = (params.subject ?? params.question ?? '').trim();
  if (!subject) return 'Error: subject required — say what the diagram should explain';

  const r = await makeDiagram(subject, { kind: params.kind, context: params.context });
  return formatDiagramResult(r);
}

/** One block of text describing what happened — shared by the tool and the auto-trigger. */
export function formatDiagramResult(r: DiagramResult): string {
  if (!r.ok) {
    return [
      `Diagram FAILED after ${r.rounds} round(s): ${r.error}`,
      r.file ? `Draft kept at ${r.file}` : '',
      r.source ? `\n${r.source}` : '',
    ].filter(Boolean).join('\n');
  }
  const bits = [
    `${r.kind ?? 'diagram'}${r.summary ? ` ${r.summary}` : ''} — validated${r.unverified ? ' STRUCTURALLY ONLY (plantuml not installed — install it to verify it renders)' : ' by plantuml'}${r.rounds > 1 ? `, ${r.rounds} rounds` : ''}`,
    `puml:  ${r.file}`,
    r.image ? `image: ${r.image}` : 'image: not rendered (no local plantuml)',
    r.opened ? 'opened in your editor' : 'left in place — open it, or preview with the VS Code PlantUML extension',
    '',
    r.source,
  ];
  return bits.filter(Boolean).join('\n');
}
