Arms a standing watch: the model plans once, writes the plan to `sentinaile_plan.md`, then a detached supervisor runs a fresh `ayin -p` against that plan on a schedule until you stop it.

Give it what to watch and how often — "check CI every 10 minutes" — and it drafts a schedule, writes the plan file, and arms it; edit the plan file directly to change what each run does without re-arming. The supervisor is detached from this session and rebuilds its state from disk, so the watch survives a reboot rather than dying with the terminal that started it. Only one sentinel is active at a time — arming a new one stops the current one first, though stopped sentinels are kept as a record rather than deleted. Bare `/sentinaile` reports what is armed; `/sentinaile stop` stops the active one.

## Examples

    /sentinaile check CI every 10 minutes
    /sentinaile
    /sentinaile stop
