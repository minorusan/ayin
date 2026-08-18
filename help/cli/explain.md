Answer a question about the codebase with a narrative — history, authorship and how it's wired up, not a file list.

`ayin explain "<feature or question>"` runs the same pipeline as the interactive `/explain`: an agentic explore pass finds and reads the relevant code, then real git history (`git log --follow` on the files explore named) supplies authorship and a churn/bugfix signal, then any Jira-ticket-shaped strings found in those commit messages are looked up against the real Jira API to confirm they are genuine tickets rather than coincidental text. One model call synthesizes all of that evidence into plain prose — no headings, no diagram. The report is written to `ayin-explain-<slug>-<timestamp>.md` in the current directory and opened in the operator's editor if one is found on PATH; the headless form also prints the narrative straight to stdout.

Every stage degrades to an honest gap rather than inventing one: no git history found is reported as exactly that, and ticket-shaped strings that fail to resolve against Jira are named as coincidental rather than attributed. Only an empty argument or an exploration that turns up nothing usable fails outright.

## Options

    "<feature or question>"   what to explain, as free text

## Examples

    ayin explain "the llm resource"
    ayin explain "how does checkout handle a declined card"
