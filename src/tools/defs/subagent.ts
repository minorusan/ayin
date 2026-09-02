import type { Tool } from '../base.js';
import { runSubagent } from '../../subagents.js';

/**
 * Hand a WHOLE stage of the work to a fresh agent.
 *
 * The description is written for the model that has to choose between this and doing the work itself,
 * so it names the ONE distinction that matters: a subagent is for a task with a boundary and a result,
 * not for a step. "Research the alarm API and write the client" is a subagent; "create pyproject.toml"
 * is a step the caller should just take.
 *
 * Withheld entirely at depth ≥ 1 — see `subagents.ts`. A subagent never sees this tool, so the
 * arbitration level stays one level deep.
 */
export const tool: Tool = {
  name: 'subagent',
  icon: '🤖',
  description:
    'Hand one whole task to a fresh agent that has its own context, its own tools and its own budget, '
    + 'and report back what it did. Use it for a STAGE of the work — "research the public alarm API and '
    + 'write a client for it", "build the web server and its template", "write the tests and make them '
    + 'pass" — never for a single file or a single command, which you should simply do yourself. When a '
    + 'plan file exists for the stage, pass its path as `plan` and the subagent will read and follow it. '
    + 'The subagent cannot spawn subagents of its own, so give it everything it needs in one task.',
  parameters: [
    {
      name: 'task',
      type: 'string',
      description: 'The whole task, stated so someone who has not read this conversation could do it: what to build, where, and what "done" means',
      required: true,
    },
    {
      name: 'plan',
      type: 'string',
      description: 'Path to a plan file the subagent must read and follow — the phase file plan mode wrote for this stage',
      required: false,
    },
    {
      name: 'cwd',
      type: 'string',
      description: 'Directory to run in. Defaults to the current one',
      required: false,
    },
  ],
  async execute(params, ctx) {
    const task = String(params.task ?? '').trim();
    if (!task) return 'Error: task required';

    // NARRATION, because a stage of the work is minutes long and a silent one looks hung. The child's
    // own progress is its business; what the parent can honestly report is that it is still going.
    ctx?.onStatus('delegating…');
    const result = await runSubagent(task, {
      cwd: params.cwd ? String(params.cwd) : undefined,
      plan: params.plan ? String(params.plan) : undefined,
      signal: ctx?.signal,
    });
    ctx?.onStatus(result.ok ? `done — ${result.toolCalls} tool call(s)` : 'failed');

    // THE STATS LINE IS NOT DECORATION. A subagent that reports success having made zero tool calls did
    // not do the work — it described it — and that is the one failure the parent cannot see from the
    // report alone, because a report of work never done reads exactly like a report of work done.
    const secs = Math.round(result.ms / 1000);
    const head = `subagent ${result.ok ? 'finished' : 'FAILED'} — ${result.toolCalls} tool call(s), ${secs}s`;
    const warn = result.ok && result.toolCalls === 0
      ? '\n\nWARNING: it made NO tool calls, so it changed nothing. Treat its report as a proposal, not as work done, and verify before moving on.'
      : '';
    return `${head}\n\n${result.report || '(it said nothing)'}${warn}`;
  },
};
