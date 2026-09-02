Toggles plan mode for the rest of the session: a big request first gets a survey, API research, and an explore pass, written out as `ayin-plan-*.md`, before the agent touches anything.

It exists because a 2000-character request is usually several features wearing one paragraph — handed straight to the agent, it starts on whichever sentence it read last and spends its budget repairing its own first guess in round nine. `/plan` is a bare toggle with no argument; once on, a long enough prompt triggers one cheap triage call that decides whether the request is genuinely multi-feature before paying for the full plan pass. For a single prompt you want planned right now, without flipping the session toggle, use `/planthis <text>` instead — it forces the pass once, even while the toggle is off.

In an EMPTY directory the plan is a setup plan: a request naming Python, TypeScript or Unity is detected from the request itself, `git init` runs before anything is written, and the plan is validated against that type's real layout — the manifest, the entry point, the test directory and a `.gitignore` — instead of against a lone README. Naming the folder works too — "a Python website in testwebsite-2" creates `testwebsite-2/`, inits the repo inside it, and writes every path in the plan prefixed with it, so you can plan a new project from the folder that holds all your others.

## Examples

    /plan
    /planthis rewrite the auth flow to use refresh tokens
    /planthis set up an empty python project for a CLI that renames files
