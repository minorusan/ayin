#!/usr/bin/env node
/**
 * check-plan — the actionable plan's deterministic half, against the built `dist`.
 *
 * `npm run check:plan` (needs a build first). No LLM, no network, nothing written anywhere.
 *
 * The plan graph's value is that a PROGRAM rejects a plan a model cannot be trusted to get right, so the
 * program is the part worth a gate. Two things are checked here:
 *
 *   - the VALIDATOR still refuses what it exists to refuse — cycles, forward dependencies, a step with
 *     no proof, a required deliverable no step produces;
 *   - the INFERENCE derives what is already written in the data, and derives nothing else. A step that
 *     touches a file an earlier step touches depends on it; the model routinely leaves that off, and
 *     `dependsOn` is RENDERED into the plan a coding agent then follows, so a missing edge is a plan
 *     that does not state its own ordering;
 *   - the GREENFIELD path routes an EMPTY directory to the executor that knows what a new project of
 *     that type looks like, and hands back exactly what `base` does once the project exists. Both
 *     halves matter: the first is the feature, and the second is every Python, Node and Unity project
 *     already on disk, which that executor is now also selected for.
 *
 * The inference is borrowed from Maradel, where the identical omission was a hard validation error that
 * cost a 9.4-second repair pass on most plans — a second model call to be told a fact the arguments
 * already contained. The shapes differ; the lesson does not.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { inferDependencies, validateSteps, renderPlan } = await import(`file://${join(DIST, 'plan', 'plan.js')}`);
const { detectProject } = await import(`file://${join(DIST, 'executors', 'detect.js')}`);
const { planExecutorFor } = await import(`file://${join(DIST, 'executors', 'registry.js')}`);
const { basePlanExecutor } = await import(`file://${join(DIST, 'executors', 'plan', 'base', 'index.js')}`);

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

/** A step with everything the validator demands, so a test can vary one thing at a time. */
const step = (over) => ({
  id: 1,
  title: 'do the thing',
  files: ['src/a.ts'],
  action: 'edit the thing so it does the other thing',
  verify: 'npm run build prints no errors',
  dependsOn: [],
  ...over,
});

console.log('\n— the validator still refuses what it is for —');
ok(validateSteps([step({})], []).length === 0, 'a clean one-step plan validates');
ok(/depends on itself/.test(validateSteps([step({ dependsOn: [1] })], []).join(' ')), 'a self-dependency is refused');
ok(
  /comes later/.test(validateSteps([step({ id: 1, dependsOn: [2] }), step({ id: 2 })], []).join(' ')),
  'a forward dependency is refused — a plan cannot contain a cycle',
);
ok(/no title/.test(validateSteps([step({ title: '  ' })], []).join(' ')), 'a step with no title is refused');
ok(
  /verify is/.test(validateSteps([step({ verify: 'ok' })], []).join(' ')),
  'a step whose proof is three characters is refused — that is where a plan hides its holes',
);
ok(
  /writes nothing/.test(validateSteps([step({ files: [] })], []).join(' ')),
  'a plan that names no file at all is refused',
);
ok(
  /produced by no step/.test(validateSteps([step({ files: ['src/a.ts'] })], ['docs/REPORT.md']).join(' ')),
  'a REQUIRED deliverable no step produces is refused — before a single file is written',
);

console.log('\n— the inference derives what is already in the data —');
{
  // The model's habit: step 2 edits the very file step 1 creates, and declares no dependency.
  const drafted = [
    step({ id: 1, title: 'create the module', files: ['src/thing.ts'] }),
    step({ id: 2, title: 'wire it up', files: ['src/thing.ts', 'src/index.ts'], dependsOn: [] }),
  ];
  const fixed = inferDependencies(drafted);
  ok(fixed[1].dependsOn.join(',') === '1', 'a step touching an earlier step\'s file depends on it', `got [${fixed[1].dependsOn}]`);
  ok(fixed[0].dependsOn.length === 0, 'and the first step gains nothing — there is nothing before it');
}
{
  const declared = [
    step({ id: 1, files: ['src/a.ts'] }),
    step({ id: 2, files: ['src/b.ts'] }),
    step({ id: 3, files: ['src/b.ts'], dependsOn: [1] }),
  ];
  const fixed = inferDependencies(declared);
  ok(
    fixed[2].dependsOn.join(',') === '1,2',
    'what the model DECLARED survives — a build legitimately follows code it shares no file with',
    `got [${fixed[2].dependsOn}]`,
  );
}
{
  const commandOnly = [step({ id: 1, files: ['src/a.ts'] }), step({ id: 2, files: [], dependsOn: [] })];
  ok(inferDependencies(commandOnly)[1].dependsOn.length === 0, 'a step that names no file gains no dependency');
}
{
  // Only BACKWARDS edges, so the inference can never manufacture the cycle the validator forbids.
  const reversed = [step({ id: 1, files: ['src/a.ts'] }), step({ id: 2, files: ['src/a.ts'] })];
  const fixed = inferDependencies(reversed);
  ok(fixed[0].dependsOn.length === 0 && fixed[1].dependsOn.join(',') === '1', 'edges point backwards only');
  ok(validateSteps(fixed, []).length === 0, 'so an inferred plan still validates — no cycle can be introduced');
}
{
  const untouched = [step({ id: 1, files: ['src/a.ts'] }), step({ id: 2, files: ['src/b.ts'] })];
  const fixed = inferDependencies(untouched);
  ok(fixed[0] === untouched[0] && fixed[1] === untouched[1], 'a plan needing nothing is returned unchanged, not rebuilt');
}

console.log('\n— and the ordering reaches the agent that follows the plan —');
{
  const fixed = inferDependencies([
    step({ id: 1, title: 'create', files: ['src/thing.ts'] }),
    step({ id: 2, title: 'wire', files: ['src/thing.ts'], dependsOn: [] }),
  ]);
  const md = renderPlan(fixed, [], []);
  ok(/after step 1/.test(md), 'the rendered plan says "after step 1" — which is the only way the executor learns it');
}

console.log('\n— an empty directory reaches the executor that knows what a new project looks like —');

/** A throwaway empty directory, so detection sees no project marker of any kind. */
const inEmptyDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'ayin-plan-gate-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

for (const [request, type, label, manifest] of [
  ['set up an empty python project for a CLI that renames files', 'python', 'Python', 'pyproject.toml'],
  ['create a new typescript project, a small library with tests', 'node', 'TypeScript', 'package.json'],
  ['start a unity project for a 2d platformer prototype', 'unity', 'Unity', 'Packages/manifest.json'],
]) {
  inEmptyDir((dir) => {
    const ctx = detectProject(dir, request);
    ok(ctx.type === type && ctx.greenfield, `"${request.slice(0, 34)}…" is a greenfield ${type} project`, `got ${ctx.type}, greenfield=${ctx.greenfield}`);
    if (ctx.type !== type) return;

    const ex = planExecutorFor(ctx);
    ok(ex.config.id === 'greenfield', `  → the greenfield plan executor`, `got "${ex.config.id}"`);

    const patterns = ex.deliverables(ctx).map((d) => d.patterns[0]);
    ok(patterns.includes(manifest), `  → \`${manifest}\` is a required deliverable, so a plan omitting it is rejected`, patterns.join(' '));
    ok(patterns.includes('.gitignore'), '  → so is .gitignore — the repository is initialised empty and the first commit is where build output gets in');
    ok(patterns.includes('README.md'), '  → and the README the base executor demands of every project');

    // The whole point of the branch: the plan is validated against a layout, not against one README.
    const errors = validateSteps([step({ files: ['README.md'] })], ex.deliverables(ctx).filter((d) => d.required).map((d) => d.patterns[0]));
    ok(errors.length >= 2, '  → a plan that writes only a README is refused before a file is written', `${errors.length} error(s)`);

    ok(ex.survey(ctx).includes(label), `  → the survey says ${label} instead of the generic Node/web one`);
    ok(/NO SOURCE IS ON DISK YET/.test(ex.survey(ctx)), '  → and says plainly that nothing is on disk');
    ok(ex.grounding(ctx, request).includes('TARGET LAYOUT'), '  → the layout is stated as grounding, so triage cannot veto the plan away');
  });
}

console.log('\n— a directory that HOLDS projects is not a project —');
{
  // The reproduced failure: standing in a folder of ten projects, "build a Python website in
  // testwebsite-2" found a sibling's Arduino/2/Janitor/Janitor.ino three levels down and planned the
  // whole container as an Arduino project, catalog and all.
  const container = mkdtempSync(join(tmpdir(), 'ayin-container-'));
  mkdirSync(join(container, 'Arduino', '2', 'Janitor'), { recursive: true });
  writeFileSync(join(container, 'Arduino', '2', 'Janitor', 'Janitor.ino'), 'void setup(){}\n');
  mkdirSync(join(container, 'webthing'), { recursive: true });
  writeFileSync(join(container, 'webthing', 'package.json'), '{"name":"webthing"}\n');
  mkdirSync(join(container, 'pything'), { recursive: true });
  writeFileSync(join(container, 'pything', 'pyproject.toml'), '[project]\nname="pything"\n');

  const request = 'Build a Python website in testwebsite-2 displaying weather for a city';
  const bare = detectProject(container, request);
  ok(bare.type !== 'arduino', 'a sibling project\'s sketch no longer decides the container\'s type', `got ${bare.type}`);
  ok(!bare.greenfield, 'and the container is not itself scaffolded — nothing git-inits a folder of projects', `greenfield=${bare.greenfield}`);

  const ctx = detectProject(container, request, 'testwebsite-2');
  ok(ctx.type === 'python' && ctx.greenfield, 'with the folder the request named, it is a greenfield python project', `${ctx.type}, greenfield=${ctx.greenfield}`);
  ok(ctx.targetDir === 'testwebsite-2', '  → and the project is created in that folder', `targetDir=${JSON.stringify(ctx.targetDir)}`);
  ok(ctx.root === container, '  → while root stays where the AGENT is, because plan paths are relative to it');

  const ex = planExecutorFor(ctx);
  const patterns = ex.deliverables(ctx).map((d) => d.patterns[0]);
  ok(
    patterns.every((p) => p.startsWith('testwebsite-2/')),
    '  → every deliverable is stated as the agent must write it, prefixed with the folder',
    patterns.join(' '),
  );
  ok(ex.survey(ctx).includes('testwebsite-2/…'), '  → and the survey says paths are never bare');

  const made = ex.scaffold(ctx);
  ok(existsSync(join(container, 'testwebsite-2')), 'the project directory is created');
  ok(existsSync(join(container, 'testwebsite-2', '.git')), 'the git repository is initialised INSIDE it, not over the container');
  ok(!existsSync(join(container, '.git')), 'the container itself is left alone');
  ok(existsSync(join(container, 'testwebsite-2', 'README.md')), 'and the README stub lands in the project, not beside it');
  ok(made.length === 3, 'all three are reported', `reported ${made.length}`);

  rmSync(container, { recursive: true, force: true });
}

console.log('\n— a name derived from prose is never trusted —');
{
  const dir = mkdtempSync(join(tmpdir(), 'ayin-target-'));
  mkdirSync(join(dir, 'existing'), { recursive: true });
  writeFileSync(join(dir, 'existing', 'main.py'), 'x\n');
  writeFileSync(join(dir, 'afile'), 'x\n');
  const req = 'set up a python project';
  for (const [name, why] of [
    ['../escape', 'a parent traversal is refused'],
    ['/etc', 'an absolute path is refused'],
    ['a/b', 'a nested path is refused'],
    ['existing', 'a directory that already holds someone\'s work is refused'],
    ['afile', 'a name that is a file is refused'],
    ['', 'an empty name is refused'],
  ]) {
    ok(detectProject(dir, req, name).targetDir === '', why, `targetDir=${JSON.stringify(detectProject(dir, req, name).targetDir)}`);
  }
  ok(detectProject(dir, req, 'brand-new_2').targetDir === 'brand-new_2', 'a plain new folder name is accepted');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n— and `git init` happens once, at project start —');
inEmptyDir((dir) => {
  const ctx = detectProject(dir, 'set up an empty python project for a CLI');
  const ex = planExecutorFor(ctx);
  const made = ex.scaffold(ctx);
  ok(existsSync(join(dir, '.git')), 'an empty git repository is initialised in the new project');
  ok(existsSync(join(dir, 'README.md')), 'and the README stub is the first file it has ever seen');
  ok(made.length === 2, 'both are reported to the operator, never done silently', `reported ${made.length}`);
  ok(ex.scaffold(ctx).length === 0, 'a second pass creates nothing — scaffolding never overwrites');
});

console.log('\n— a project that ALREADY exists is handed straight back to the base executor —');
{
  // The registry selects on TYPE, not on greenfield-ness, so `plan/greenfield` is also chosen for every
  // Python, Node and Unity project on disk. This is the half that must not have changed for them.
  const ctx = detectProject(REPO, 'add a typescript module for X');
  ok(ctx.type === 'node' && !ctx.greenfield, 'this repo is an existing node project', `${ctx.type}, greenfield=${ctx.greenfield}`);
  const ex = planExecutorFor(ctx);
  ok(ex.config.id === 'greenfield', 'which the greenfield executor is still selected for');
  ok(ex.grounding(ctx, 'x') === basePlanExecutor.grounding(ctx, 'x'), '  → grounding is the base\'s (empty), so triage keeps its veto');
  ok(
    JSON.stringify(ex.deliverables(ctx)) === JSON.stringify(basePlanExecutor.deliverables(ctx)),
    '  → deliverables are the base\'s, not a layout for a project that already has one',
  );
  ok(ex.observability(ctx) === basePlanExecutor.observability(ctx), '  → observability is the base\'s');
  ok(ex.scaffold(ctx).length === 0, '  → and nothing is scaffolded into a repo that already has a README and a .git');
}

console.log(fails ? `\nplan check: ${fails} FAILED` : '\nplan check: all passed');
process.exit(fails ? 1 : 0);
