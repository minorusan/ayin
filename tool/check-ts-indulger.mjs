#!/usr/bin/env node
/**
 * check-ts-indulger — the facts a TypeScript chunk carries, and the ones it must refuse to invent.
 *
 * Attribution states FACTS, never advice or guesses. A wrong fact is worse than a missing one: the
 * chunk travels with it, a reader has no way to check it, and "registered in agent.ts" sends someone
 * looking for a registration that was never there. So most of this suite is about refusing.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.argv.push('-p');

let fails = 0;
const ok = (c, label, extra = '') => {
  console.log(`${c ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!c) fails++;
};

const { typescriptIndulger, exportedNames, promptIdsUsed, listMembership, clearTypescriptIndulgerMemo } =
  await import('../dist/indulge/indulgers/typescript.js');

// A repo shaped like ayin: a registry holding a list, a plain hub that merely calls, a gate, prompts.
const R = mkdtempSync(join(tmpdir(), 'ayin-tsi-'));
const w = (rel, body) => {
  mkdirSync(join(R, rel, '..'), { recursive: true });
  writeFileSync(join(R, rel), body);
};
w('package.json', '{"name":"x"}\n');
w('tsconfig.json', '{}\n');
w('src/dialects/glimmer.ts', 'export class GlimmerDialect {}\n');
w('src/dialects/gemma.ts', 'export class GemmaDialect {}\n');
// A REGISTRY: it declares membership by putting the thing in a list.
w('src/manager.ts',
  "import { GlimmerDialect } from './dialects/glimmer.js';\n"
  + "import { GemmaDialect } from './dialects/gemma.js';\n"
  + 'const DIALECTS = [new GlimmerDialect(), new GemmaDialect()];\nexport { DIALECTS };\n');
// A HUB: imports it and calls it, but registers nothing.
w('src/agent.ts', "import { GlimmerDialect } from './dialects/glimmer.js';\nnew GlimmerDialect().go();\n");
// A GATE: asserts about it from outside.
w('tool/check-dialects.mjs', "// asserts about src/dialects/glimmer.ts\nimport '../src/dialects/glimmer.js';\n");
// Prompts: a string that names a file.
w('prompts/ayin/planTriage.txt', 'triage\n');
w('src/plan.ts', "const p = getPrompt('planTriage', {});\nconst q = getPrompt('noSuchPrompt', {});\nexport const runPlan = () => p;\n");

const factsFor = (rel, src) =>
  typescriptIndulger.onChunkCreated({}, { repoPath: R, file: rel, source: src });

console.log('it applies to a TypeScript project');
ok(typescriptIndulger.applies(R), 'package.json + tsconfig.json is a TS project');
ok(!typescriptIndulger.applies(tmpdir()), 'an arbitrary directory is not');

console.log('\nmembership is a CHECKABLE fact, not an import count');
{
  clearTypescriptIndulgerMemo();
  const f = factsFor('src/dialects/glimmer.ts', 'export class GlimmerDialect {}\n');
  ok(f?.registeredIn?.includes('src/manager.ts'),
    'the file whose LIST contains it is the registry', JSON.stringify(f?.registeredIn));
  ok(!f?.registeredIn?.includes('src/agent.ts'),
    'a hub that merely imports and calls it is NOT a registry — counting imports called agent.ts one');
  ok(f?.usedBy?.includes('src/agent.ts'), '…the hub is reported as a plain user instead');
  ok(f?.assertedBy?.includes('tool/check-dialects.mjs'),
    'the gate asserting about it is named — it is why the behaviour may not change');
  ok((f?.assertedBy ?? []).length === new Set(f?.assertedBy ?? []).size,
    'no duplicates — gates are .mjs and must not be scanned twice');
}

console.log('\nan ambiguous name attributes NOTHING');
{
  // Every tool definition in a real repo exports `tool`; matching on it registered a definition
  // wherever the word appeared in any list, including files that register nothing.
  w('src/defs/a.ts', 'export const tool = { name: "a" };\n');
  w('src/defs/b.ts', 'export const tool = { name: "b" };\n');
  w('src/collect.ts', "import { tool } from './defs/a.js';\nconst TOOLS = [tool];\nexport { TOOLS };\n");
  clearTypescriptIndulgerMemo();
  const f = factsFor('src/defs/a.ts', 'export const tool = { name: "a" };\n');
  ok(!f?.registeredIn?.length,
    'a name several files export cannot identify one of them — so nothing is claimed',
    JSON.stringify(f?.registeredIn));
}

console.log('\nthe string that names a FILE is resolved');
{
  clearTypescriptIndulgerMemo();
  const src = "const p = getPrompt('planTriage', {});\nconst q = getPrompt('noSuchPrompt', {});\nexport const runPlan = () => p;\n";
  const f = factsFor('src/plan.ts', src);
  const used = (f?.promptsUsed ?? []).map((x) => x.id);
  ok(used.includes('planTriage'), 'a prompt id is resolved to its .txt');
  ok((f?.promptsUsed ?? []).some((x) => x.file === 'prompts/ayin/planTriage.txt'), '…by path');
  ok((f?.promptIdsWithNoFile ?? []).includes('noSuchPrompt'),
    'an id with NO file is reported — that call throws at runtime by design');
}

console.log('\nthe primitives');
{
  ok(exportedNames('export function a(){}\nexport const b = 1;\nexport { c as d };\n').sort().join(',') === 'a,b,d',
    'exports are read from declarations and from export lists');
  ok(promptIdsUsed("getPrompt('x')").includes('x'), 'getPrompt id is found');
  ok(!promptIdsUsed('getPrompt(variable)').length, 'a non-literal id is not guessed at');
  ok(listMembership('const A = [one, two];', 'two'), 'membership inside a list is seen');
  ok(!listMembership('const A = one; two();', 'two'), 'a bare call is not membership');
}

console.log('\nfacts are absent rather than empty when there is nothing to say');
{
  clearTypescriptIndulgerMemo();
  ok(factsFor('README.md', '# hi') === null, 'a non-source file gets no facts');
  ok(factsFor('src/lonely.ts', 'const x = 1;\n') === null, 'a file with nothing to attribute returns null');
}

console.log(fails ? `\nts-indulger check: ${fails} FAILED` : '\nts-indulger check: all good');
process.exit(fails ? 1 : 0);
