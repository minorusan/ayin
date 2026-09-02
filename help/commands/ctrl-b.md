Moves whatever is running to the background. The run keeps going exactly as it was, the turn continues without it, and you get your prompt back.

Nothing is cancelled and nothing is lost. When the run finishes, its result is delivered into the session on its own and saved as an artifact you can read with Ctrl+O.

Every run currently holding the turn moves, not just one — parallel subagents are a single stage of work, and unblocking you means unblocking you from the stage. Silent when nothing is running.

The agent is told, in place of the output it was waiting for, that the run moved and that its result will arrive by itself. There is nothing for it to poll and nothing for it to re-run.

## Backgrounding is only parallel if the run answers somewhere else

A self-hosted model is one **queue**, not a lock: two callers take turns. So detaching a task hands back your prompt but not the GPU, and your next message still waits behind the task you just moved. `/set-background-model` points backgrounded runs at an endpoint with its own capacity, which is what makes them genuinely run alongside you.

With no background model set, Ctrl+B still detaches and says so. It just does not buy you a second lane.

A `subagent` is a separate process, so its model was fixed when it was spawned: backgrounding one mid-flight detaches it, but the model calls it has left stay where they are. Set the background model before it starts and the child is born in the lane. An in-process tool — explore, a plan phase, QA, a connector — does change lane mid-flight, on its next model call.

## It works while the agent has the terminal

That is the only moment it is for, so it is one of the few keys that does not need an idle prompt. Esc still interrupts; Ctrl+B is the opposite of interrupting.

## Examples

    Ctrl+B      a subagent is running → it finishes on its own, you keep working
    Ctrl+O      later — read what it returned
