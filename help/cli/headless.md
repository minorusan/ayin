Run one task to completion with no terminal UI, printing the result and exiting.

`ayin -p "<task>"` (or `--prompt`, or `--prompt=<task>`) skips the TUI entirely: it connects to the configured model, opens a session record, sends the prompt through the same agent loop the interactive chat uses, and prints the outcome to stdout before exiting with status 0, or exits 1 on a connection or agent error. This is the form to call from a script, a cron job, or another program that wants one answer back.

Headless auto-approves every tool call — file writes and shell commands run without a confirmation dialog — with one exception: `git push`, `git pull` and `git checkout` are always denied outright, never asked, because there is nobody present to answer "may I push?" Run it only on a git working tree that can be diffed and reverted afterward. Set `AYIN_TRANSCRIBE=1` or pass `--transcribe` to write a full JSON transcript of prompts, raw model replies, and tool results for a run nobody was watching live.

## Options

    -p "<task>", --prompt "<task>"   the task to run non-interactively
    --prompt=<task>                  same, as a single argument
    --non-interactive "<task>"       same effect as -p
    --transcribe                     write a full transcript of the run to disk
    --dangerously-skip-permissions   no effect here — headless already auto-approves

## Examples

    ayin -p "add a null check to parseConfig and run the build"
    ayin --prompt="summarize the failing tests" --transcribe
