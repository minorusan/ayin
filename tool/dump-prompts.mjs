/**
 * Prompt audit — dump every prompt ayin can send to a model, as JSON.
 *
 * WHY A TOOL RATHER THAN A ONE-OFF. "Prompts live in files, never inline in source" is a
 * non-negotiable rule in this repo, and a rule with no way to check it is a rule that decays. This
 * answers the three questions an audit actually asks:
 *
 *   1. WHAT is in each prompt — the full text, byte for byte, as the model receives it.
 *   2. WHO reaches it — every `file:line` in src/ that names the id. An id nobody names is either
 *      dead weight or a call site the grep cannot see; both are worth knowing.
 *   3. WHAT ISN'T HERE — call sites that build a prompt in a template literal instead of loading one.
 *      Reported as suspects, not verdicts: the rule says extract them, and this is how you find them.
 *
 * Also reports the LOCAL override state. Prompts are read at call time from `~/.ayin-cli/prompts/`,
 * never from the repo — so an operator edit is what the model actually gets, and an audit of the
 * shipped text alone would be auditing something nobody is running.
 *
 *   node tool/dump-prompts.mjs [outfile.json]      (default: ayin-prompts-audit.json in cwd)
 */

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPTS = join(ROOT, 'prompts');
const LOCAL_ROOT = process.env.AYIN_PROMPTS_DIR || join(homedir(), '.ayin-cli', 'prompts');
const OUT = process.argv[2] || join(process.cwd(), 'ayin-prompts-audit.json');

// ── every source file, so we can find who names each id ──────────────
const sources = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (/^(node_modules|dist|\.git)$/.test(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (!/\.(ts|mjs|js)$/.test(entry)) continue;
    sources.push({ path: relative(ROOT, full), lines: readFileSync(full, 'utf8').split('\n') });
  }
})(join(ROOT, 'src'));

function callSites(id) {
  const needle = `'${id}'`;
  const alt = `"${id}"`;
  const hits = [];
  for (const f of sources) {
    f.lines.forEach((line, i) => {
      if (!line.includes(needle) && !line.includes(alt)) return;
      // A prompt is reached either by a direct load — `getPrompt('x')`, `nsPrompts.get('x')`,
      // `this.prompt('x')` — or by being named in a TABLE that a loader later reads (the QA
      // baseline's `{ id, prompt: 'baselineX' }` rows are the whole standing bar and would
      // otherwise all read as dead).
      const isLoad = /\b(get|prompt|getPrompt)\s*\(/.test(line);
      const isTableRef = /\bprompt\s*:\s*['"]/.test(line);
      if (!isLoad && !isTableRef) return;
      hits.push({ file: f.path, line: i + 1, via: isLoad ? 'direct load' : 'named in a prompt table', code: line.trim().slice(0, 200) });
    });
  }
  return hits;
}

// ── the prompts themselves ───────────────────────────────────────────
const namespaces = readdirSync(PROMPTS).filter((d) => statSync(join(PROMPTS, d)).isDirectory()).sort();
const prompts = [];

for (const ns of namespaces) {
  for (const file of readdirSync(join(PROMPTS, ns)).filter((f) => f.endsWith('.txt')).sort()) {
    const id = basename(file, '.txt');
    const sourcePath = join(PROMPTS, ns, file);
    const shipped = readFileSync(sourcePath, 'utf8');
    const localPath = join(LOCAL_ROOT, ns, file);
    const hasLocal = existsSync(localPath);
    const local = hasLocal ? readFileSync(localPath, 'utf8') : null;
    const sites = callSites(id);

    prompts.push({
      namespace: ns,
      id,
      ref: `${ns}/${id}`,
      shippedPath: relative(ROOT, sourcePath),
      // What the model ACTUALLY receives: the local copy when the operator has one.
      effectiveText: local ?? shipped,
      effectiveSource: hasLocal ? 'local (operator copy)' : 'shipped (not yet materialized)',
      localPath: hasLocal ? localPath : null,
      operatorEdited: hasLocal && local !== shipped,
      shippedText: hasLocal && local !== shipped ? shipped : undefined,
      // The dangerous half of "operator edited". Wording drift is a preference; VARIABLE drift means
      // the code passes data the prompt never asks for — silently, with nothing logged. See
      // `PromptDrift` in src/prompts-service.ts.
      variableDrift: (() => {
        if (!hasLocal) return null;
        const l = new Set([...local.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
        const s = new Set([...shipped.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
        const missing = [...s].filter((v) => !l.has(v)).sort();
        const stale = [...l].filter((v) => !s.has(v)).sort();
        return missing.length || stale.length ? { neverReceives: missing, rendersLiterally: stale } : null;
      })(),
      chars: (local ?? shipped).length,
      approxTokens: Math.ceil((local ?? shipped).length / 4),
      variables: [...new Set([...(local ?? shipped).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort(),
      callSites: sites,
      reachable: sites.length > 0,
    });
  }
}

// ── suspects: a model call whose content is built inline ─────────────
//
// "Prompts live in files, never inline in source" is a non-negotiable rule here, so this looks for
// violations of it. The naive version — flag any `llmChat` whose `content:` is not literally a
// `.get(...)` call — is useless: it fires on the transport functions themselves and on every call
// site that loaded its prompt into a variable three lines earlier, which is nearly all of them.
// Thirteen findings, thirteen false positives, and an audit nobody reads twice.
//
// So: resolve the identifier. If `content:` names a variable, look back for where that variable was
// assigned, and accept it when the assignment is a prompt load. Only a genuinely inline string or
// template literal survives.
const LOADER = /(getPrompt|[A-Za-z]*[Pp]rompts?\.get|this\.prompt|\.bundle\.get)\s*\(/;
const suspects = [];
for (const f of sources) {
  // The transport layer is where `content:` is SUPPOSED to be a bare parameter — it is the thing
  // every prompt eventually flows through, not a prompt of its own.
  if (/^src\/(connection|llm\/manager)\.ts$/.test(f.path)) continue;
  f.lines.forEach((line, i) => {
    if (!/(llmChat|llmCall)\s*\(/.test(line)) return;
    const window = f.lines.slice(i, i + 8).join('\n');
    const m = window.match(/content:\s*([^,\n}]+)/);
    if (!m) return;
    const expr = m[1].trim();
    if (LOADER.test(expr)) return;                       // loaded right here
    const ident = expr.match(/^([A-Za-z_$][\w$]*)/)?.[1];
    if (ident) {
      // Where did this variable come from? Look back a reasonable distance for its assignment.
      const back = f.lines.slice(Math.max(0, i - 25), i).join('\n');
      const assign = back.match(new RegExp(`\\b${ident}\\s*(?::[^=]*)?=\\s*([\\s\\S]{0,200})`));
      if (assign && LOADER.test(assign[1])) return;      // loaded a few lines up
      if (/^(prompt|messages|content|body)$/.test(ident) && !assign) return; // a parameter, not a literal
    }
    suspects.push({
      file: f.path, line: i + 1, contentExpression: expr,
      code: f.lines.slice(i, i + 3).map((l) => l.trim()).join(' ⏎ ').slice(0, 240),
    });
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  package: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
  localPromptsRoot: LOCAL_ROOT,
  summary: {
    namespaces: namespaces.length,
    prompts: prompts.length,
    totalChars: prompts.reduce((a, p) => a + p.chars, 0),
    approxTotalTokens: prompts.reduce((a, p) => a + p.approxTokens, 0),
    operatorEdited: prompts.filter((p) => p.operatorEdited).map((p) => p.ref),
    // The finding that actually costs you a feature — read this row first.
    variableDrift: prompts.filter((p) => p.variableDrift).map((p) => ({ ref: p.ref, ...p.variableDrift })),
    notMaterializedLocally: prompts.filter((p) => !p.localPath).map((p) => p.ref),
    unreachable: prompts.filter((p) => !p.reachable).map((p) => p.ref),
    inlinePromptSuspects: suspects.length,
  },
  byNamespace: Object.fromEntries(namespaces.map((ns) => {
    const rows = prompts.filter((p) => p.namespace === ns);
    return [ns, { count: rows.length, chars: rows.reduce((a, p) => a + p.chars, 0), ids: rows.map((p) => p.id) }];
  })),
  prompts,
  inlinePromptSuspects: suspects,
};

writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[dump-prompts] ${prompts.length} prompts across ${namespaces.length} namespaces → ${OUT}`);
console.log(`[dump-prompts] ~${report.summary.approxTotalTokens} tokens of prompt text total`);
if (report.summary.unreachable.length) console.log(`[dump-prompts] NOT NAMED BY ANY CALL SITE: ${report.summary.unreachable.join(', ')}`);
if (report.summary.operatorEdited.length) console.log(`[dump-prompts] operator-edited (local differs from shipped): ${report.summary.operatorEdited.join(', ')}`);
for (const d of report.summary.variableDrift) {
  console.log(`[dump-prompts] VARIABLE DRIFT ${d.ref}:`
    + (d.neverReceives.length ? ` your local copy never receives ${d.neverReceives.map((v) => `{{${v}}}`).join(', ')};` : '')
    + (d.rendersLiterally.length ? ` ${d.rendersLiterally.map((v) => `{{${v}}}`).join(', ')} will render literally;` : '')
    + ' restore or hand-merge it — nothing else will tell you.');
}
if (suspects.length) console.log(`[dump-prompts] ${suspects.length} model call(s) whose content may be built inline — check them against the "prompts live in files" rule`);
