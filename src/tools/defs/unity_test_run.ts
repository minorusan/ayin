/**
 * `unity_test_run` — run named Unity test assemblies and report what happened.
 *
 * The engine is `testrun/`, which already knew how to do this and had no caller but the CLI:
 * `compiledState` decides whether the prebuilt DLLs can be trusted, `toolConfirm` asks before
 * anything quits an editor, `runBatchmode` passes `-assemblyNames` so a run is scoped rather than
 * whole-project, and `formatReport` refuses to fold a not-run assembly into a green total. None of
 * that is re-implemented here.
 *
 * WHAT THIS ADDS is the selection. `runTestrunCli` picks assemblies from corpus DOMAINS — prose like
 * "reward service" resolved through indulge — which is the right door for a person and the wrong one
 * for an agent that has just read `RewardStreakIntegrationTests.cs` and knows exactly which assembly
 * owns it. Here the caller names them, `unity_tests_which` is how it learns the names, and a name
 * that matches nothing is reported rather than quietly dropped.
 *
 * THE PROMPT IS NOT OPTIONAL AND NOT OURS TO SKIP. Batch mode needs the project to itself, so with
 * the Editor open the operator is asked whether to quit it — and `toolConfirm` returns null when
 * there is nobody to ask, which `runSelection` treats as a refusal. A scheduled run does not get to
 * close someone's editor because it could not reach them.
 */

import type { Tool } from '../base.js';
import { projectRoot } from '../../qa/probes.js';
import { buildAsmdefIndex, isUnityProject } from '../../testrun/asmdef.js';
import { formatReport, runSelection, type Selection } from '../../testrun/index.js';

export const tool: Tool = {
  name: 'unity_test_run',
  icon: '🧪',
  projects: ['unity'],
  description:
    'Run named Unity test assemblies and report pass/fail per test. Get the names from '
    + 'unity_tests_which first — a run is scoped by assembly, and running everything takes an hour. '
    + 'When the compiled DLLs are current it runs those in seconds; when anything is stale it needs '
    + 'Unity batch mode, which needs the Editor closed, and the operator is ASKED before that happens. '
    + 'If they decline, or nobody is there to ask, nothing runs and the reply says so.',
  parameters: [
    { name: 'assemblies', type: 'string', description: 'Test assembly names, comma or semicolon separated — exactly as unity_tests_which prints them', required: true },
  ],

  async execute(params) {
    const repo = projectRoot();
    if (!isUnityProject(repo)) return `Error: ${repo} is not a Unity project — no ProjectSettings/ProjectVersion.txt`;

    const asked = String(params.assemblies ?? '')
      .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    if (!asked.length) return 'Error: assemblies required — name them, comma separated. unity_tests_which lists them.';

    const index = buildAsmdefIndex(repo);
    const tests = index.all.filter((a) => a.isTest);
    const matched = asked.map((n) => tests.find((a) => a.name.toLowerCase() === n.toLowerCase()) ?? null);
    const unknown = asked.filter((_, i) => matched[i] === null);
    const assemblies = matched.filter((a): a is NonNullable<typeof a> => a !== null);

    // NAMED AND NOT FOUND IS AN ERROR, not a smaller run. Dropping one silently turns "the tests
    // pass" into a claim about assemblies nobody chose.
    if (unknown.length) {
      const near = tests.map((a) => a.name).slice(0, 12).join(', ');
      return `Error: no test assembly named ${unknown.join(', ')}.\n`
        + `This project has ${tests.length}: ${near}${tests.length > 12 ? ', …' : ''}\n`
        + `unity_tests_which lists them with their platform and compiled state.`;
    }

    // `domains` is what `formatReport` prints as the header; for a named run the names ARE the scope.
    const selection: Selection = { domains: assemblies.map((a) => a.name), files: [], assemblies, guessed: false };
    const result = await runSelection(repo, selection);
    return formatReport(result);
  },
};
