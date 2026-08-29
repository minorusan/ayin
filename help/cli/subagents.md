A **subagent** is a whole stage of the work handed to a fresh agent: its own context, its own tools, its own budget. It reports back what it did, and the agent that called it never has to hold the stage's twenty-odd steps in its head.

This is what plan mode's phases are for. Each phase gets its own plan file, and the top-level agent calls `subagent` once per phase with that file's path — it arbitrates, it does not implement. Before this, every phase's steps were inlined into every round's prompt: on a five-phase request that was 27,138 characters against a 12,000-character cap, so the last two phases were cut off and the thing the request actually asked for never reached the model.

## Two rules

**A subagent cannot spawn subagents.** Depth travels in the environment, and below the top level the tool is not registered at all — the model never sees it. Without that, every child could re-plan and re-delegate, and there would be no arbitration level, only recursion.

**Parallel is off by default.** Two agents editing one tree race on every file they share, and the loser's write vanishes with nothing in any output to say so. `--allow-parallel-subagents` turns it on when you know a plan's phases are independent; otherwise several subagent calls in one response run one after another, in the order the plan gave them.

## Flags

    ayin --disallow-subagents            work every phase in one agent, no delegation
    ayin --allow-parallel-subagents      run several subagents at once (off by default)

`AYIN_SUBAGENTS=0` and `AYIN_PARALLEL_SUBAGENTS=1` are the environment equivalents, for a harness that cannot pass flags. `subagentTimeoutMs` in `~/.ayin-cli/prompts.json` caps how long one subagent may run (default 15 minutes); when it is hit the child is killed and whatever it had already written stands.

## Reading the result

A subagent's result opens with its own statistics — `subagent finished — 14 tool call(s), 96s`. **Zero tool calls means it changed nothing:** it described the work rather than doing it, and a report of work never done reads exactly like a report of work done. The result says so explicitly when that happens.
