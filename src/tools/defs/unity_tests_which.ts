/**
 * `unity_tests_which` — what test assemblies this project has, and what running them would cost.
 *
 * The question `unity_test_run` cannot answer for itself. A run is scoped by `-assemblyNames`, which
 * is the difference between minutes and an hour on a tree this size, and the model had no way to
 * learn the names: they live in `.asmdef` files, `isTest` is decided by an NUnit reference rather
 * than by anything in the name, and EditMode versus PlayMode is `includePlatforms` being exactly
 * `["Editor"]`. Guessing "SomethingTests" finds some of them and invents the rest.
 *
 * COMPILED STATE IS PART OF THE ANSWER, not a detail of the run. An assembly whose sources are newer
 * than its DLL cannot be trusted from `Library/ScriptAssemblies`, and one that was never compiled
 * cannot run at all — both force batch mode, which is the path that wants the Editor closed. Saying
 * so here lets the model choose a cheap scope before it asks anyone to quit their editor.
 */

import type { Tool } from '../base.js';
import { projectRoot } from '../../qa/probes.js';
import { buildAsmdefIndex, compiledState, isUnityProject, unityHasProjectOpen } from '../../testrun/asmdef.js';

export const tool: Tool = {
  name: 'unity_tests_which',
  icon: '🧪',
  projects: ['unity'],
  description:
    'List this project\'s test assemblies — their names, EditMode or PlayMode, the folder each covers, '
    + 'and whether its compiled DLL is current. Read-only and instant. Call it before unity_test_run to '
    + 'pick a scope: a run names assemblies, and running every test in a large project takes an hour.',
  parameters: [
    { name: 'filter', type: 'string', description: 'Only assemblies whose name or folder contains this text', required: false },
  ],

  async execute(params) {
    const repo = projectRoot();
    if (!isUnityProject(repo)) return `Error: ${repo} is not a Unity project — no ProjectSettings/ProjectVersion.txt`;
    const index = buildAsmdefIndex(repo);
    const all = index.all.filter((a) => a.isTest);
    if (!all.length) return 'No test assemblies in this project — no .asmdef references NUnit.';

    const want = String(params.filter ?? '').trim().toLowerCase();
    const tests = want
      ? all.filter((a) => `${a.name} ${a.dir}`.toLowerCase().includes(want))
      : all;
    if (!tests.length) return `No test assembly matches "${params.filter}". ${all.length} exist — call again with no filter to see them.`;

    const compiled = compiledState(repo, tests);
    const stateOf = (name: string): string => {
      const c = compiled.find((x) => x.asmdef.name === name);
      if (!c || !c.dll) return 'NOT COMPILED — needs batch mode';
      return c.stale ? 'stale — sources newer than the DLL, needs batch mode' : 'current';
    };

    const rows = tests.map((a) => {
      const platform = a.editorOnly ? 'EditMode' : 'PlayMode';
      return `  ${a.name}\n    ${platform} · ${a.dir}\n    ${stateOf(a.name)}`;
    });
    const open = unityHasProjectOpen(repo)
      ? '\n\nUnity has this project open. Anything needing batch mode will ask to close it first.'
      : '';
    return `${tests.length} test assembly(ies)${want ? ` matching "${params.filter}"` : ''} of ${all.length}:\n\n`
      + `${rows.join('\n\n')}\n\nRun them with unity_test_run(assemblies="Name1,Name2").${open}`;
  },
};
