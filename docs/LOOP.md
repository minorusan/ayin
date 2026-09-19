# The agentic loop — as a state machine

`ARCHITECTURE.md` says what the parts are. This says **what the loop is doing at any instant, and
every way it can leave.** It is a UML state machine diagram (a statechart).

Read it like this:

- A **rounded box is a state.** The loop is in exactly one of them at a time.
- An **arrow is a transition**, labelled `event [guard] / action`: *when this happens, if this holds,
  do this, then move.*
- `[*]` at the top is where a turn starts; `[*]` at the bottom is where it ends.
- A **box drawn inside a box** is a nested machine — the round loop lives inside the turn.

Why this diagram and not a sequence diagram or a flowchart: a statechart forces every state to
enumerate **all** of its exits. A state with a way in and no guard on the way out is visible at a
glance, and that class of defect is the expensive one here — see `RESTART_MAX` in `src/lost.ts`.

---

## 1 · The run, the turn, and the restart chain

A **run** is one task. A **turn** is one attempt at it with one context. A clap ends a turn and starts
a new one — same process, fresh context, carrying a report.

```mermaid
stateDiagram-v2
    direction TB
    [*] --> Run

    state Run {
        [*] --> Turn : resetLost() · resetSkepticRun() · capture originalGoal

        state Turn {
            [*] --> Rounds : clear window, ledger, file views, echo table, skeptic state<br/>beginLostTurn() · beginVerifyTurn(treeDirty)
            Rounds --> [*]
        }

        Turn --> Finished : finish() confirmed
        Turn --> Answered : final answer, nothing was touched
        Turn --> Unverified : verify budget spent / write unverified report
        Turn --> Lost : clap
        Turn --> Capped : round cap reached

        Lost --> Turn : [restartDepth < 5] / relaunch with originalGoal + report<br/>report describes the TREE, not this turn's ledger<br/>depth++
        Lost --> Exhausted : [restartDepth >= 5] / report and stop

        Finished --> [*]
        Answered --> [*]
        Unverified --> [*]
        Exhausted --> [*]
        Capped --> [*]
    }
```

**The load-bearing guard is `[restartDepth >= 5]`.** Without it `Lost --> Turn` is unconditional and
the machine has no exit: measured at twelve restarts and four hours of wall clock on one instance,
with duration tracking `(restarts + 1) x one attempt` almost linearly. Every run that ever reached
`Finished` did so at depth 5 or less.

Two things deliberately do **not** reset on `Lost --> Turn`: `restartDepth`, so the chain can be
bounded, and the accumulated dead ends, so attempt 5 knows which routes attempts 1–4 closed. Everything
else is wiped — that is what "sober" means.

**The report's contents must come from state the transition does not clear.** They did not: `changed`
was read from the per-turn QA ledger, which the next turn's entry action wipes. A restarted turn
therefore reported "Nothing. The working tree is clean." over a correct one-line fix sitting in the
file, and took the no-edit branch of the mandate — *"Make the edit the task asks for"* — telling the
agent to redo work it had already done. That is how a clean fix acquires a second, conflicting one.
It now reads `git status --porcelain`: the tree survives a restart, and `status` rather than
`diff --name-only` because a file the agent CREATED is a change the report must name.

---

## 2 · Inside a turn: one round

```mermaid
stateDiagram-v2
    direction TB
    [*] --> Building

    Building --> Exiting : interrupted
    Building --> AskingForAccount : [verify budget spent]<br/>/ push ACCOUNT_REQUEST
    Building --> Generating : / llm_call

    AskingForAccount --> Generating

    Generating --> CapturingAccount : [account was requested]
    CapturingAccount --> Exiting : / write unverified report

    Generating --> Parsing : reply

    Parsing --> Dispatching : [reply has tool calls]
    Parsing --> Idle : [no tool call, but the turn has touched something]
    Parsing --> Answering : [no tool call, nothing touched]

    Idle --> Building : / discard the round, retry the step
    Idle --> Exiting : [noteCall says clap]

    Answering --> Building : [looks like a deferral, first time] / nudge
    Answering --> Exiting : / final answer

    state Dispatching {
        direction TB
        [*] --> Checking
        Checking --> Blocked : [guard refuses]
        Checking --> Running : [allowed]
        Running --> Echoed : [output identical to a previous call]
        Running --> Landed : [new output]
        Blocked --> [*]
        Echoed --> [*]
        Landed --> [*]
    }

    Dispatching --> Holding : [tool is finish]
    Dispatching --> Building : / note the call, push the result
    Dispatching --> Exiting : [noteCall says clap]

    Holding --> Building : [no account yet, nothing changed] / ask for the account
    Holding --> Building : [skeptic pass opens] / ask for an observation
    Holding --> Building : [diff not yet shown] / show the whole diff once
    Holding --> Exiting : / honour finish

    Exiting --> [*]
```

`Blocked`, `Echoed` and `Landed` all report to the same detector. That matters: the first version of
the detector only saw `Blocked`, and was therefore blind to the loop that actually burns the card —
accepted calls, each differing from the last by a few bytes, cycling forever.

`Holding` is where `finish()` goes to be questioned. Each of its three gates fires **at most once per
turn**, so the door cannot be held shut indefinitely; the next `finish()` after each one is honoured.

---

## 3 · The detector (`src/lost.ts`)

Runs on every call — blocked, echoed or landed. It holds a window of the last 20 `(call, result)`
pairs and asks one question: *did the last stretch of work do anything new?*

```mermaid
stateDiagram-v2
    direction TB
    [*] --> Working

    Working --> Clapped : refusals in a row >= 3
    Working --> Clapped : same (call, result) pair >= 4 in the window
    Working --> Clapped : two calls alternating for 6 turns
    Working --> Nudged : same call >= 6 in the window, first time<br/>/ tell the model · DROP those entries from the window

    Nudged --> Working : any other call
    Nudged --> Clapped : that same call >= 6 again

    Clapped --> [*] : one clap per turn · depth++
```

**`/ DROP those entries from the window` is not bookkeeping — it is the whole mechanism.** Without it
the six copies that triggered the nudge stay in the window, so the model's *next* call — any call —
re-satisfies the rule with the key already marked, and claps. Measured twice on live runs: nudge at
round 37, clap at round 38, zero refusals in the entire run. A nudge the model is given no room to obey
is a clap with a longer name.

The same-call rule is the only one that nudges first. The other three are never productive: identical
refusals, an identical call *and* result, two calls taking turns. This one can be — six runs of a
reproduction script is plausibly a model building understanding.

**No budget lives in this file.** Not rounds, not money, not a clock. It never asks how much work has
been done, only whether the last stretch of it was the *same* work. A run that keeps learning things
runs forever, by design; `finish()` remains the only ordinary way out.

---

## Keeping this true

This diagram is behaviour, so the rule in `CLAUDE.md` applies: **a change to the loop updates this file
in the same change.** Concretely, a change needs an edit here when it adds or removes a state, adds or
removes a way out of one, or changes a guard's condition. Renaming a variable does not.

The three files this describes: `src/agent.ts` (the turn and the round), `src/lost.ts` (the detector
and the restart bound), `src/skeptic-pass.ts` (the verification budget and the `finish` gates).
