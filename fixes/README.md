# fixes/

Fix requests made from the TUI with **`/fix <what should change about ayin>`**, and the answers.

| File | Written by | Meaning |
|---|---|---|
| `fix-<id>.md` | ayin, when you type `/fix` | the request: front-matter (`id`, `status`, `created`) + your prompt |
| `rejection-<id>.md` | the agent | it did **not** do it — what was asked, why not, what it would need |
| `archive/` | you, via `/fix clear` | rejections you've read and acknowledged |

`<id>` is `YYYYMMDD-HHMMSS` (with a `-2`, `-3`, … suffix if two land in the same second).

A headless Claude Code run picks the request up, implements it, bumps the patch version, commits
and publishes to the registry — or writes the rejection and stops. **A clean refusal is a good
outcome**; a wrong guess published to every machine is not.

While a rejection sits here unarchived, every ayin session shows a red **FIX REJECTED** in the
status bar. Read it with `/fix show <id>`, clear it with `/fix clear`.

The queue itself is *not* here — it lives in `~/.ayin-cli/fixes/` (state, logs, lock) so the agent
can't commit it and a `git clean` can't lose it. See `docs/ARCHITECTURE.md` → "/fix".
