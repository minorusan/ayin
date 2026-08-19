Start the interactive terminal agent in the current directory.

With no subcommand, `ayin` runs a preflight check for a reachable model, then opens the blessed-based TUI in the working directory it was launched from. On a fresh install it walks through a one-time setup — a local Ollama it finds, an OpenAI key, or a custom endpoint — and writes the choice to `~/.ayin-cli/prompts.json` so it never asks again while a model keeps answering. A model already reachable (an inherited env var, another tool's config) is offered as the default, so confirming costs one keypress.

Past the gate, ayin connects to the model, opens a local session record under `~/.ayin-cli`, and starts a live mirror of the run so another process can see what it is doing without a debug bundle. It also polls the configured update registry every 10 minutes, showing a hint in the status bar when a newer build is published. Use `ayin -p` instead for one unattended task, or an `ayin <subcommand>` form for a job that needs no chat loop.

## Options

    --dangerously-skip-permissions   auto-approve tool calls for this session (git push/pull/checkout are still confirmed)
    --thinking                       enable thinking-mode output
    --debug                          write a debug bundle at boot, then run normally (same as typing /debug)
    --help, -h, help                 print the command list and exit (skips the model check)

## Examples

    ayin
    ayin --dangerously-skip-permissions
    ayin --debug
