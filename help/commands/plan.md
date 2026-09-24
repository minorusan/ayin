Toggles plan mode for the rest of the session: a big request first gets a survey, API research, and an explore pass, written out as `ayin-plan-*.md`, before the agent touches anything.

It exists because a 2000-character request is usually several features wearing one paragraph — handed straight to the agent, it starts on whichever sentence it read last and spends its budget repairing its own first guess in round nine. `/plan` is a bare toggle with no argument; once on, a long enough prompt triggers one cheap triage call that decides whether the request is genuinely multi-feature before paying for the full plan pass. For a single prompt you want planned right now, without flipping the session toggle, use `/planthis <text>` instead — it forces the pass once, even while the toggle is off.

In an EMPTY directory the plan is a setup plan: a request naming Python, TypeScript or Unity is detected from the request itself, `git init` and the layout are written the moment you approve the plan, and the plan is validated against that type's real layout — the manifest, the entry point, the test directory and a `.gitignore` — instead of against a lone README. Naming the folder works too — "a Python website in testwebsite-2" creates `testwebsite-2/` on approval, inits the repo inside it, and writes every path in the plan prefixed with it, so you can plan a new project from the folder that holds all your others.

Triage also decides what KIND of request it is. A **question about the codebase** ("is this icon baked
in or set at runtime?") gets an investigation plan — ordered reads, no file is written, and the last
step has to state the answer. A **question the codebase cannot answer** ("what do you think of these
tools?") gets no plan at all, because plan mode's only other shape is a list of files to create, and
asked to fill that for a question it will invent files to create. Work still gets the plan it always
got. `/planthis` overrides the veto: you asked, so you get one.

The plan is a **proposal**: it is written to `.ayin/plans/`, nothing else on disk is touched — no
scaffold, no `git init`, no commit — and the turn stops there. Reply `go` to run it, `cancel` to drop
it, or say what to change and it is re-planned with your words as the requirement. Anything that is not
one of those exact words is read as a change, so `go and also rename the module` revises rather than
runs. Headless (`-p`) approves itself; `planApproval: 0` under `config` in `~/.ayin-cli/prompts.json` turns
the gate off in the TUI.

Once it runs, each phase is checked: a step can carry a shell command that must exit 0, ayin runs it
when the phase finishes, and a phase whose checks fail re-plans the phases after it rather than letting
the run drift on a broken assumption.

## Examples

    /plan
    /planthis rewrite the auth flow to use refresh tokens
    /planthis set up an empty python project for a CLI that renames files
