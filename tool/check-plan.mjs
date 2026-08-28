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
 *     that does not state its own ordering.
 *
 * The inference is borrowed from Maradel, where the identical omission was a hard validation error that
 * cost a 9.4-second repair pass on most plans — a second model call to be told a fact the arguments
 * already contained. The shapes differ; the lesson does not.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { inferDependencies, validateSteps, renderPlan } = await import(`file://${join(DIST, 'plan', 'plan.js')}`);

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

console.log(fails ? `\nplan check: ${fails} FAILED` : '\nplan check: all passed');
process.exit(fails ? 1 : 0);
